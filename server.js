import express from "express";
import cors from "cors";

const app = express();

app.use(express.json());

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN
      ? process.env.ALLOWED_ORIGIN.split(",")
      : true
  })
);

const PORT = process.env.PORT || 3000;

const GHL_BASE_URL = "https://services.leadconnectorhq.com";

const CONFIG = {
  token: process.env.GHL_PRIVATE_TOKEN,

  locationId:
    process.env.GHL_LOCATION_ID ||
    "jZWaBd5kIRLZb0OioGDX",

  serviceId:
    process.env.GHL_SERVICE_ID ||
    "6aa31e32d519d3b90f569200",

  staffId:
    process.env.GHL_STAFF_ID ||
    "aRPvgSI0a1wsdMJTTiG8",

  serviceLocationId:
    process.env.GHL_SERVICE_LOCATION_ID ||
    "69a9e70ec7aae1643cd3ecb6",

  timezone:
    process.env.GHL_TIMEZONE ||
    "America/New_York",

  capacity:
    Number(process.env.RESOURCE_CAPACITY || 15),

  durationMinutes:
    Number(process.env.SERVICE_DURATION_MINUTES || 30),

  slotIntervalMinutes:
    Number(process.env.SLOT_INTERVAL_MINUTES || 30),

  openHour:
    Number(process.env.OPEN_HOUR || 9),

  closeHour:
    Number(process.env.CLOSE_HOUR || 17)
};

const headers = () => ({
  Authorization: `Bearer ${CONFIG.token}`,
  Version: "v3",
  Accept: "application/json",
  "Content-Type": "application/json"
});

function validateConfig() {
  if (!CONFIG.token) {
    throw new Error("GHL_PRIVATE_TOKEN is missing");
  }
}

function toDateTime(date, hour, minute) {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");

  // We intentionally send local service time.
  // GHL also receives the timezone separately.
  return `${date}T${hh}:${mm}:00`;
}

function addMinutes(localDateTime, minutes) {
  const date = new Date(`${localDateTime}Z`);

  date.setUTCMinutes(date.getUTCMinutes() + minutes);

  return date.toISOString().slice(0, 19);
}

function convertLocalTimeToTimestamp(dateString, timezone) {
  /*
    Native JS does not provide a perfect direct
    "local time in timezone -> epoch" conversion.

    We can safely create the boundaries through
    Intl by calculating the timezone offset.
  */

  const temporaryUTC = new Date(`${dateString}Z`);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(temporaryUTC);

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  const formattedAsUTC = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );

  const offset = formattedAsUTC - temporaryUTC.getTime();

  return temporaryUTC.getTime() - offset;
}

function overlaps(bookingStart, bookingEnd, slotStart, slotEnd) {
  return bookingStart < slotEnd && bookingEnd > slotStart;
}

async function ghlFetch(path, options = {}) {
  validateConfig();

  const response = await fetch(`${GHL_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...headers(),
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    console.error("GHL API Error", {
      path,
      status: response.status,
      response: data
    });

    const error = new Error(
      data?.message ||
      data?.error ||
      `GHL API request failed with ${response.status}`
    );

    error.status = response.status;
    error.details = data;

    throw error;
  }

  return data;
}

async function getServiceBookings(date) {
  const startLocal = `${date}T00:00:00`;
  const endLocal = `${date}T23:59:59`;

  const startMs = convertLocalTimeToTimestamp(
    startLocal,
    CONFIG.timezone
  );

  const endMs = convertLocalTimeToTimestamp(
    endLocal,
    CONFIG.timezone
  );

  const params = new URLSearchParams({
    locationId: CONFIG.locationId,
    startTime: String(startMs),
    endTime: String(endMs),
    timezone: CONFIG.timezone,
    serviceLocationId: CONFIG.serviceLocationId
  });

  const data = await ghlFetch(
    `/calendars/services/bookings?${params}`
  );

  return Array.isArray(data.bookings)
    ? data.bookings
    : [];
}

function bookingUsesService(booking) {
  /*
    Some GHL list responses may not expose full
    service objects depending on API response shape.

    If services are available, filter by service.
    Otherwise the serviceLocation/date filter is
    used for this POC.
  */

  if (!Array.isArray(booking.services)) {
    return true;
  }

  return booking.services.some(
    service =>
      service.id === CONFIG.serviceId ||
      service.serviceId === CONFIG.serviceId
  );
}

function activeBookings(bookings) {
  return bookings.filter(booking => {
    if (booking.deleted === true) return false;

    const status = String(
      booking.status || ""
    ).toLowerCase();

    if (status === "cancelled" || status === "canceled") {
      return false;
    }

    return bookingUsesService(booking);
  });
}

function calculateSlotUsage(bookings, startTime, endTime) {
  const slotStart = convertLocalTimeToTimestamp(
    startTime,
    CONFIG.timezone
  );

  const slotEnd = convertLocalTimeToTimestamp(
    endTime,
    CONFIG.timezone
  );

  return activeBookings(bookings).filter(booking => {
    const bookingStart = Date.parse(booking.startTime);
    const bookingEnd = Date.parse(booking.endTime);

    if (
      Number.isNaN(bookingStart) ||
      Number.isNaN(bookingEnd)
    ) {
      return false;
    }

    return overlaps(
      bookingStart,
      bookingEnd,
      slotStart,
      slotEnd
    );
  }).length;
}

function generateSlots(date, bookings) {
  const slots = [];

  let hour = CONFIG.openHour;
  let minute = 0;

  while (
    hour < CONFIG.closeHour ||
    (hour === CONFIG.closeHour && minute === 0)
  ) {
    const start = toDateTime(
      date,
      hour,
      minute
    );

    const end = addMinutes(
      start,
      CONFIG.durationMinutes
    );

    const endHour = Number(
      end.slice(11, 13)
    );

    const endMinute = Number(
      end.slice(14, 16)
    );

    if (
      endHour > CONFIG.closeHour ||
      (
        endHour === CONFIG.closeHour &&
        endMinute > 0
      )
    ) {
      break;
    }

    const booked = calculateSlotUsage(
      bookings,
      start,
      end
    );

    const remaining = Math.max(
      CONFIG.capacity - booked,
      0
    );

    slots.push({
      startTime: start,
      endTime: end,
      capacity: CONFIG.capacity,
      booked,
      remaining,
      available: remaining > 0
    });

    minute += CONFIG.slotIntervalMinutes;

    while (minute >= 60) {
      hour += 1;
      minute -= 60;
    }
  }

  return slots;
}

async function upsertContact({
  firstName,
  lastName,
  email,
  phone
}) {
  const body = {
    locationId: CONFIG.locationId,
    firstName,
    lastName,
    email,
    phone,
    source: "Custom Capacity Booking Funnel"
  };

  const data = await ghlFetch(
    "/contacts/upsert",
    {
      method: "POST",
      body: JSON.stringify(body)
    }
  );

  const contact =
    data.contact ||
    data;

  if (!contact?.id) {
    throw new Error(
      "GHL did not return a contact ID"
    );
  }

  return contact;
}

async function createServiceBooking({
  contactId,
  startTime,
  endTime
}) {
  const params = new URLSearchParams({
    overrideAvailability: "true"
  });

  const body = {
    locationId: CONFIG.locationId,
    contactId,

    startTime,
    endTime,

    timezone: CONFIG.timezone,

    services: [
      {
        id: CONFIG.serviceId,
        staffId: CONFIG.staffId
      }
    ],

    serviceLocationId:
      CONFIG.serviceLocationId,

    title:
      "Capacity Test Service",

    status:
      "confirmed"
  };

  return ghlFetch(
    `/calendars/services/bookings?${params}`,
    {
      method: "POST",
      body: JSON.stringify(body)
    }
  );
}

/*
|--------------------------------------------------------------------------
| Health Check
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "GHL Capacity Booking API"
  });
});

/*
|--------------------------------------------------------------------------
| Availability
|--------------------------------------------------------------------------
*/

app.get("/api/availability", async (req, res) => {
  try {
    const { date } = req.query;

    if (
      !date ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "date is required in YYYY-MM-DD format"
      });
    }

    const bookings =
      await getServiceBookings(date);

    const slots =
      generateSlots(date, bookings);

    return res.json({
      success: true,
      serviceId: CONFIG.serviceId,
      date,
      timezone: CONFIG.timezone,
      capacity: CONFIG.capacity,
      durationMinutes:
        CONFIG.durationMinutes,
      slots
    });
  } catch (error) {
    console.error(
      "Availability error:",
      error
    );

    return res
      .status(error.status || 500)
      .json({
        success: false,
        message: error.message,
        details:
          process.env.NODE_ENV === "production"
            ? undefined
            : error.details
      });
  }
});

/*
|--------------------------------------------------------------------------
| Create Booking
|--------------------------------------------------------------------------
*/

app.post("/api/book", async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phone,
      startTime
    } = req.body;

    if (
      !firstName ||
      !email ||
      !startTime
    ) {
      return res.status(400).json({
        success: false,
        message:
          "firstName, email and startTime are required"
      });
    }

    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(
        startTime
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid startTime format"
      });
    }

    const date =
      startTime.slice(0, 10);

    const endTime =
      addMinutes(
        startTime,
        CONFIG.durationMinutes
      );

    /*
      IMPORTANT:
      Re-check availability immediately before
      creating the booking.
    */

    const bookings =
      await getServiceBookings(date);

    const booked =
      calculateSlotUsage(
        bookings,
        startTime,
        endTime
      );

    const remaining =
      CONFIG.capacity - booked;

    if (remaining <= 0) {
      return res.status(409).json({
        success: false,
        code: "SLOT_FULL",
        message:
          "This time slot is now full. Please choose another time."
      });
    }

    /*
      Create or update the GHL contact.
    */

    const contact =
      await upsertContact({
        firstName,
        lastName,
        email,
        phone
      });

    /*
      Create overlapping Service Booking.
    */

    const booking =
      await createServiceBooking({
        contactId: contact.id,
        startTime,
        endTime
      });

    return res.status(201).json({
      success: true,
      message:
        "Booking created successfully",
      contactId: contact.id,
      bookingId:
        booking.bookingId ||
        booking.id ||
        booking?.booking?.bookingId,
      booking
    });
  } catch (error) {
    console.error(
      "Booking error:",
      error
    );

    return res
      .status(error.status || 500)
      .json({
        success: false,
        message: error.message,
        details:
          process.env.NODE_ENV === "production"
            ? undefined
            : error.details
      });
  }
});

app.listen(PORT, () => {
  console.log(
    `GHL Capacity Booking API running on port ${PORT}`
  );
});