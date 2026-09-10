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

const GHL_BASE_URL =
  "https://services.leadconnectorhq.com";

const CONFIG = {
  token:
    process.env.GHL_PRIVATE_TOKEN,

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

  resourceId:
    process.env.GHL_RESOURCE_ID ||
    "6a835165bddbb5aee81480fd",

  resourceCapacity:
    Number(
      process.env.RESOURCE_CAPACITY || 15
    ),

  timezone:
    process.env.GHL_TIMEZONE ||
    "America/New_York",

  durationMinutes:
    Number(
      process.env.SERVICE_DURATION_MINUTES || 30
    ),

  slotIntervalMinutes:
    Number(
      process.env.SLOT_INTERVAL_MINUTES || 30
    ),

  openHour:
    Number(process.env.OPEN_HOUR || 5),

  closeHour:
    Number(process.env.CLOSE_HOUR || 17)
};

/*
|--------------------------------------------------------------------------
| GHL Headers
|--------------------------------------------------------------------------
*/

function ghlHeaders() {
  return {
    Authorization:
      `Bearer ${CONFIG.token}`,
    Version: "v3",
    Accept: "application/json",
    "Content-Type": "application/json"
  };
}

/*
|--------------------------------------------------------------------------
| GHL Fetch Helper
|--------------------------------------------------------------------------
*/

async function ghlFetch(
  path,
  options = {}
) {
  if (!CONFIG.token) {
    throw new Error(
      "GHL_PRIVATE_TOKEN is missing"
    );
  }

  const response = await fetch(
    `${GHL_BASE_URL}${path}`,
    {
      ...options,
      headers: {
        ...ghlHeaders(),
        ...(options.headers || {})
      }
    }
  );

  const raw =
    await response.text();

  let data;

  try {
    data =
      raw
        ? JSON.parse(raw)
        : {};
  } catch {
    data = {
      raw
    };
  }

  if (!response.ok) {
    console.error(
      "GHL API Error",
      {
        path,
        status:
          response.status,
        data
      }
    );

    const error =
      new Error(
        data?.message ||
        data?.error ||
        `GHL API error ${response.status}`
      );

    error.status =
      response.status;

    error.details =
      data;

    throw error;
  }

  return data;
}

/*
|--------------------------------------------------------------------------
| Timezone Helpers
|--------------------------------------------------------------------------
*/

function localTimeToEpoch(
  localDateTime,
  timezone
) {
  const temporaryUTC =
    new Date(
      `${localDateTime}Z`
    );

  const formatter =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          timezone,

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit",

        hour:
          "2-digit",

        minute:
          "2-digit",

        second:
          "2-digit",

        hour12:
          false
      }
    );

  const parts =
    formatter.formatToParts(
      temporaryUTC
    );

  const values = {};

  for (const part of parts) {
    if (
      part.type !==
      "literal"
    ) {
      values[
        part.type
      ] =
        part.value;
    }
  }

  const formattedAsUTC =
    Date.UTC(
      Number(
        values.year
      ),
      Number(
        values.month
      ) - 1,
      Number(
        values.day
      ),
      Number(
        values.hour
      ),
      Number(
        values.minute
      ),
      Number(
        values.second
      )
    );

  const offset =
    formattedAsUTC -
    temporaryUTC.getTime();

  return (
    temporaryUTC.getTime() -
    offset
  );
}

function addMinutes(
  localDateTime,
  minutes
) {
  const value =
    new Date(
      `${localDateTime}Z`
    );

  value.setUTCMinutes(
    value.getUTCMinutes() +
    minutes
  );

  return value
    .toISOString()
    .slice(0, 19);
}

function buildLocalDateTime(
  date,
  hour,
  minute
) {
  return (
    `${date}T` +
    `${String(hour).padStart(2, "0")}:` +
    `${String(minute).padStart(2, "0")}:00`
  );
}

/*
|--------------------------------------------------------------------------
| Get Service Bookings
|--------------------------------------------------------------------------
*/

async function getBookingsForDate(
  date
) {
  const dayStart =
    `${date}T00:00:00`;

  const dayEnd =
    `${date}T23:59:59`;

  const startMs =
    localTimeToEpoch(
      dayStart,
      CONFIG.timezone
    );

  const endMs =
    localTimeToEpoch(
      dayEnd,
      CONFIG.timezone
    );

  const params =
    new URLSearchParams({
      locationId:
        CONFIG.locationId,

      startTime:
        String(startMs),

      endTime:
        String(endMs),

      timezone:
        CONFIG.timezone,

      serviceLocationId:
        CONFIG.serviceLocationId
    });

  const data =
    await ghlFetch(
      `/calendars/services/bookings?${params.toString()}`
    );

  return Array.isArray(
    data.bookings
  )
    ? data.bookings
    : [];
}

/*
|--------------------------------------------------------------------------
| Booking Validation
|--------------------------------------------------------------------------
*/

function isActiveBooking(
  booking
) {
  if (
    booking.deleted === true
  ) {
    return false;
  }

  const status =
    String(
      booking.status || ""
    ).toLowerCase();

  const excludedStatuses = [
    "cancelled",
    "canceled",
    "invalid"
  ];

  return !excludedStatuses.includes(
    status
  );
}

/*
|--------------------------------------------------------------------------
| RESOURCE CHECK
|--------------------------------------------------------------------------
|
| This is the important change.
|
| We do NOT check only the Service ID.
|
| We check whether any service inside the booking uses:
|
| serviceResources[].id === CONFIG.resourceId
|
|--------------------------------------------------------------------------
*/

function bookingUsesResource(
  booking
) {
  if (
    !Array.isArray(
      booking.services
    )
  ) {
    return false;
  }

  return booking.services.some(
    service => {

      if (
        !Array.isArray(
          service.serviceResources
        )
      ) {
        return false;
      }

      return (
        service.serviceResources.some(
          resource =>
            resource.id ===
            CONFIG.resourceId
        )
      );
    }
  );
}

/*
|--------------------------------------------------------------------------
| Time Overlap
|--------------------------------------------------------------------------
*/

function bookingOverlapsSlot(
  booking,
  slotStartMs,
  slotEndMs
) {
  const bookingStart =
    Date.parse(
      booking.startTime
    );

  const bookingEnd =
    Date.parse(
      booking.endTime
    );

  if (
    Number.isNaN(
      bookingStart
    ) ||
    Number.isNaN(
      bookingEnd
    )
  ) {
    return false;
  }

  return (
    bookingStart <
      slotEndMs &&
    bookingEnd >
      slotStartMs
  );
}

/*
|--------------------------------------------------------------------------
| Calculate Resource Usage
|--------------------------------------------------------------------------
*/

function calculateResourceUsage(
  bookings,
  slotStart,
  slotEnd
) {
  const slotStartMs =
    localTimeToEpoch(
      slotStart,
      CONFIG.timezone
    );

  const slotEndMs =
    localTimeToEpoch(
      slotEnd,
      CONFIG.timezone
    );

  const matchingBookings =
    bookings.filter(
      booking =>
        isActiveBooking(
          booking
        ) &&
        bookingUsesResource(
          booking
        ) &&
        bookingOverlapsSlot(
          booking,
          slotStartMs,
          slotEndMs
        )
    );

  return {
    used:
      matchingBookings.length,

    bookingIds:
      matchingBookings.map(
        booking =>
          booking.bookingId
      )
  };
}

/*
|--------------------------------------------------------------------------
| Generate Slots
|--------------------------------------------------------------------------
*/

function generateSlots(
  date,
  bookings
) {
  const slots = [];

  let hour =
    CONFIG.openHour;

  let minute = 0;

  while (
    hour <
    CONFIG.closeHour
  ) {
    const startTime =
      buildLocalDateTime(
        date,
        hour,
        minute
      );

    const endTime =
      addMinutes(
        startTime,
        CONFIG.durationMinutes
      );

    const usage =
      calculateResourceUsage(
        bookings,
        startTime,
        endTime
      );

    const remaining =
      Math.max(
        CONFIG.resourceCapacity -
          usage.used,
        0
      );

    slots.push({
      startTime,
      endTime,

      resourceId:
        CONFIG.resourceId,

      capacity:
        CONFIG.resourceCapacity,

      used:
        usage.used,

      remaining,

      available:
        remaining > 0,

      bookingIds:
        usage.bookingIds
    });

    minute +=
      CONFIG.slotIntervalMinutes;

    if (
      minute >= 60
    ) {
      hour +=
        Math.floor(
          minute / 60
        );

      minute =
        minute % 60;
    }
  }

  return slots;
}

/*
|--------------------------------------------------------------------------
| Contact Upsert
|--------------------------------------------------------------------------
*/

async function upsertContact({
  firstName,
  lastName,
  email,
  phone
}) {
  const body = {
    locationId:
      CONFIG.locationId,

    firstName,
    lastName,
    email,
    phone,

    source:
      "Custom Capacity Booking Funnel"
  };

  const data =
    await ghlFetch(
      "/contacts/upsert",
      {
        method:
          "POST",

        body:
          JSON.stringify(
            body
          )
      }
    );

  const contact =
    data.contact ||
    data;

  if (
    !contact?.id
  ) {
    throw new Error(
      "No contact ID returned from GHL"
    );
  }

  return contact;
}

/*
|--------------------------------------------------------------------------
| Create Service Booking
|--------------------------------------------------------------------------
*/

async function createBooking({
  contactId,
  startTime,
  endTime
}) {
  const params =
    new URLSearchParams({
      overrideAvailability:
        "true"
    });

  const body = {
    locationId:
      CONFIG.locationId,

    contactId,

    startTime,
    endTime,

    timezone:
      CONFIG.timezone,

    services: [
      {
        id:
          CONFIG.serviceId,

        staffId:
          CONFIG.staffId
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
    `/calendars/services/bookings?${params.toString()}`,
    {
      method:
        "POST",

      body:
        JSON.stringify(
          body
        )
    }
  );
}

/*
|--------------------------------------------------------------------------
| Health
|--------------------------------------------------------------------------
*/

app.get(
  "/",
  (req, res) => {

    res.json({
      success:
        true,

      service:
        "GHL Resource Capacity Booking API",

      resourceId:
        CONFIG.resourceId,

      capacity:
        CONFIG.resourceCapacity
    });
  }
);

/*
|--------------------------------------------------------------------------
| Availability
|--------------------------------------------------------------------------
*/

app.get(
  "/api/availability",
  async (
    req,
    res
  ) => {

    try {
      const {
        date
      } =
        req.query;

      if (
        !date ||
        !/^\d{4}-\d{2}-\d{2}$/.test(
          date
        )
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "date is required in YYYY-MM-DD format"
          });
      }

      const bookings =
        await getBookingsForDate(
          date
        );

      const slots =
        generateSlots(
          date,
          bookings
        );

      return res.json({
        success:
          true,

        date,

        timezone:
          CONFIG.timezone,

        resource: {
          id:
            CONFIG.resourceId,

          capacity:
            CONFIG.resourceCapacity
        },

        totalBookingsReturned:
          bookings.length,

        slots
      });

    } catch (
      error
    ) {

      console.error(
        "Availability error",
        error
      );

      return res
        .status(
          error.status ||
          500
        )
        .json({
          success:
            false,

          message:
            error.message
        });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Book
|--------------------------------------------------------------------------
*/

app.post(
  "/api/book",
  async (
    req,
    res
  ) => {

    try {
      const {
        firstName,
        lastName,
        email,
        phone,
        startTime
      } =
        req.body;

      if (
        !firstName ||
        !email ||
        !startTime
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "firstName, email and startTime are required"
          });
      }

      const date =
        startTime.slice(
          0,
          10
        );

      const endTime =
        addMinutes(
          startTime,
          CONFIG.durationMinutes
        );

      /*
      |--------------------------------------------------------------------------
      | Re-check resource capacity
      |--------------------------------------------------------------------------
      */

      const bookings =
        await getBookingsForDate(
          date
        );

      const usage =
        calculateResourceUsage(
          bookings,
          startTime,
          endTime
        );

      const remaining =
        CONFIG.resourceCapacity -
        usage.used;

      if (
        remaining <= 0
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            code:
              "RESOURCE_FULL",

            message:
              "This time slot is fully booked. Please choose another time.",

            resourceId:
              CONFIG.resourceId,

            capacity:
              CONFIG.resourceCapacity,

            used:
              usage.used,

            remaining:
              0
          });
      }

      /*
      |--------------------------------------------------------------------------
      | Create/find contact
      |--------------------------------------------------------------------------
      */

      const contact =
        await upsertContact({
          firstName,
          lastName,
          email,
          phone
        });

      /*
      |--------------------------------------------------------------------------
      | Create GHL booking
      |--------------------------------------------------------------------------
      */

      const booking =
        await createBooking({
          contactId:
            contact.id,

          startTime,
          endTime
        });

      /*
      |--------------------------------------------------------------------------
      | Optional verification
      |--------------------------------------------------------------------------
      |
      | Return what capacity should now be after this booking.
      |
      */

      return res
        .status(201)
        .json({
          success:
            true,

          message:
            "Booking created successfully",

          contactId:
            contact.id,

          bookingId:
            booking.bookingId ||
            booking.id ||
            booking?.booking?.bookingId,

          resource: {
            id:
              CONFIG.resourceId,

            capacity:
              CONFIG.resourceCapacity,

            usedBeforeBooking:
              usage.used,

            expectedUsedAfterBooking:
              usage.used + 1,

            expectedRemainingAfterBooking:
              Math.max(
                CONFIG.resourceCapacity -
                (
                  usage.used +
                  1
                ),
                0
              )
          },

          booking
        });

    } catch (
      error
    ) {

      console.error(
        "Booking error",
        error
      );

      return res
        .status(
          error.status ||
          500
        )
        .json({
          success:
            false,

          message:
            error.message,

          details:
            process.env.NODE_ENV ===
            "production"
              ? undefined
              : error.details
        });
    }
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Server running on port ${PORT}`
    );
  }
);
