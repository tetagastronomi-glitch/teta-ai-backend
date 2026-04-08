function toInt1to5(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < 1 || i > 5) return null;
  return i;
}

function normalizeFeedbackRatings(body) {
  let loc = body.location_rating;
  let hos = body.hospitality_rating;
  let food = body.food_rating;
  let price = body.price_rating;

  if (
    (loc === undefined || hos === undefined || food === undefined || price === undefined) &&
    body.ratings && typeof body.ratings === "object"
  ) {
    loc = loc ?? body.ratings.location;
    hos = hos ?? body.ratings.hospitality;
    food = food ?? body.ratings.food;
    price = price ?? body.ratings.price;
  }

  const single = body.rating ?? body.ratings;
  if (
    (loc === undefined || hos === undefined || food === undefined || price === undefined) &&
    (typeof single === "number" || typeof single === "string")
  ) {
    loc = loc ?? single;
    hos = hos ?? single;
    food = food ?? single;
    price = price ?? single;
  }

  return {
    location_rating: toInt1to5(loc),
    hospitality_rating: toInt1to5(hos),
    food_rating: toInt1to5(food),
    price_rating: toInt1to5(price),
  };
}

function toBoolOrNull(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "po", "ok"].includes(s)) return true;
  if (["false", "0", "no", "jo"].includes(s)) return false;
  return null;
}

function segmentFromDays(daysSince) {
  if (daysSince === null || daysSince === undefined) return "UNKNOWN";
  const n = Number(daysSince);
  if (!Number.isFinite(n)) return "UNKNOWN";
  if (n <= 14) return "ACTIVE";
  if (n <= 30) return "WARM";
  return "COLD";
}

module.exports = { toInt1to5, normalizeFeedbackRatings, toBoolOrNull, segmentFromDays };
