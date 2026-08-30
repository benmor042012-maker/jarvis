// tools/weather.js
// Free weather via Open-Meteo. Geocoding + forecast, no key.

const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";

export const weather_def = {
  name: "weather",
  description:
    "מזג האוויר הנוכחי ותחזית ל-24 שעות עבור עיר. מקבל שם עיר (עברית או אנגלית) ומחזיר טמפרטורה, הרגשה, סיכוי גשם, רוח.",
  input_schema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "שם עיר, למשל 'תל אביב' או 'Tel Aviv'",
      },
    },
    required: ["location"],
  },
};

export async function weather({ location }) {
  const geo = await fetch(
    `${GEOCODE}?name=${encodeURIComponent(location)}&count=1&language=he`
  ).then((r) => r.json()).catch(() => null);
  const hit = geo?.results?.[0];
  if (!hit) return { error: `לא נמצאה עיר בשם ${location}` };

  const { latitude, longitude, name, country, timezone } = hit;
  const params = new URLSearchParams({
    latitude,
    longitude,
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
    hourly: "temperature_2m,precipitation_probability,weather_code",
    forecast_days: "2",
    timezone: timezone || "auto",
  });
  const fc = await fetch(`${FORECAST}?${params}`).then((r) => r.json()).catch(() => null);
  if (!fc?.current) return { error: "forecast unavailable" };

  const now = fc.current;
  const hourly = fc.hourly || {};
  const times = hourly.time || [];
  const nowIdx = findNowIdx(times);
  const next24 = [];
  for (let i = nowIdx; i < Math.min(nowIdx + 24, times.length); i++) {
    next24.push({
      time: times[i],
      temp: hourly.temperature_2m?.[i],
      precip_prob: hourly.precipitation_probability?.[i],
      code: weatherCodeHe(hourly.weather_code?.[i]),
    });
  }

  return {
    location: `${name}${country ? ", " + country : ""}`,
    current: {
      temperature_c: now.temperature_2m,
      feels_like_c: now.apparent_temperature,
      humidity_pct: now.relative_humidity_2m,
      precipitation_mm: now.precipitation,
      wind_kmh: now.wind_speed_10m,
      condition: weatherCodeHe(now.weather_code),
    },
    next_24h: next24,
  };
}

function findNowIdx(times) {
  const now = Date.now();
  for (let i = 0; i < times.length; i++) {
    if (new Date(times[i]).getTime() >= now) return i;
  }
  return 0;
}

function weatherCodeHe(code) {
  const map = {
    0: "בהיר",
    1: "בעיקר בהיר",
    2: "מעונן חלקית",
    3: "מעונן",
    45: "ערפל",
    48: "ערפל קפוא",
    51: "טפטוף קל",
    53: "טפטוף",
    55: "טפטוף חזק",
    61: "גשם קל",
    63: "גשם",
    65: "גשם חזק",
    71: "שלג קל",
    73: "שלג",
    75: "שלג חזק",
    80: "ממטרים",
    81: "ממטרים חזקים",
    82: "ממטרים אלימים",
    95: "סופת רעמים",
    96: "סופה עם ברד",
    99: "סופה עם ברד חזק",
  };
  return map[code] || `קוד ${code}`;
}
