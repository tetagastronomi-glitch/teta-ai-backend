const { z } = require("zod");
const { APP_VERSION } = require("../config/constants");

// ==================== SCHEMAS ====================

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
const timeRegex = /^\d{1,2}:\d{2}$/;

const reservationSchema = z.object({
  customer_name: z.string().min(2, "customer_name duhet të ketë të paktën 2 karaktere"),
  phone: z.string().min(9, "phone duhet të ketë të paktën 9 karaktere"),
  date: z.string().regex(dateRegex, "date duhet të jetë YYYY-MM-DD"),
  time: z.string().regex(timeRegex, "time duhet të jetë HH:MM"),
  people: z.coerce.number().int().min(1, "people duhet 1-50").max(50, "people duhet 1-50"),
});

const customerSchema = z.object({
  name: z.string().min(2, "name duhet të ketë të paktën 2 karaktere"),
  phone: z.string().min(9, "phone duhet të ketë të paktën 9 karaktere"),
});

const ownerReservationSchema = z.object({
  customer_name: z.string().min(2, "customer_name duhet të ketë të paktën 2 karaktere"),
  phone: z.string().min(9, "phone duhet të ketë të paktën 9 karaktere"),
  date: z.string().regex(dateRegex, "date duhet të jetë YYYY-MM-DD").optional(),
  time: z.string().regex(timeRegex, "time duhet të jetë HH:MM").optional(),
  people: z.coerce.number().int().min(1).max(50).optional(),
});

// ==================== MIDDLEWARE FACTORY ====================

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      return res.status(400).json({
        success: false,
        version: APP_VERSION,
        error: errors[0],
        errors,
        error_code: "VALIDATION_ERROR",
      });
    }
    req.validated = result.data;
    next();
  };
}

module.exports = {
  validate,
  reservationSchema,
  customerSchema,
  ownerReservationSchema,
};
