# חיבור ג'רביס ל-Gmail וליומן Google (חינם, פעם אחת)

זה מה שנותן לג'רביס את מה שרואים בסרטונים:
"Jarvis controls your calendar 24/7" ו-"Woke up to everything already handled".
הכל דרך ה-API הרשמי של Google, בלי תשלום ובלי פלטפורמה חיצונית.

## 1. פרויקט ב-Google Cloud (3 דקות)

1. היכנס ל-<https://console.cloud.google.com> עם חשבון ה-Gmail שלך.
2. למעלה: **Select a project ← New Project** ← שם: `jarvis` ← Create.
3. בתפריט: **APIs & Services ← Library**. חפש והפעל (Enable) שניים:
   - **Gmail API**
   - **Google Calendar API**
4. **APIs & Services ← OAuth consent screen**:
   - User type: **External** ← Create.
   - App name: `JARVIS`, User support email: המייל שלך, Developer contact: המייל שלך ← Save.
   - בטאב **Audience** (או "Test users"): הוסף את כתובת ה-Gmail שלך.
     (האפליקציה נשארת במצב Testing. זה בסדר לשימוש אישי, ואין צורך באימות של Google.)
5. **APIs & Services ← Credentials ← Create Credentials ← OAuth client ID**:
   - Application type: **Web application**
   - Name: `jarvis-worker`
   - Authorized redirect URIs ← Add URI:
     ```
     https://jarvis-proxi.ben-mor-04-2012.workers.dev/google/callback
     ```
     (אם כתובת ה-Worker שלך שונה, שים אותה עם `/google/callback` בסוף.)
   - Create. העתק את **Client ID** ואת **Client secret**.

## 2. סודות ב-Cloudflare (דקה)

בתיקיית הפרויקט:

```bash
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler d1 execute jarvis-memory --file=schema.sql   # יוצר את הטבלאות החדשות
wrangler deploy
```

## 3. אישור חד-פעמי (30 שניות)

פתח בדפדפן:

```
https://jarvis-proxi.ben-mor-04-2012.workers.dev/google/auth?userId=effi
```

בחר את החשבון, לחץ **Continue** גם במסך "Google hasn't verified this app" (זו האפליקציה שלך),
ואשר גישה ל-Gmail וליומן. תראה "JARVIS מחובר ל-Google". זהו.

לבדיקה: `https://<worker>/google/status?userId=effi` צריך להחזיר `connected: true`.

## 4. תדריך הבוקר (ג'רביס "מתקשר" ב-6:00)

כבר מופעל. כל בוקר בשעה 6:00 (שעון ישראל) ה-Worker:

1. קורא את המיילים שהגיעו בלילה.
2. מנסח **טיוטות** תשובה למיילים שדורשים מענה (לא שולח כלום בלי אישור שלך).
3. מושך את היומן של היום, את התזכורות ואת מזג האוויר.
4. כותב תדריך קצר בעברית ושולח אותו:
   - לטלגרם (אם הבוט מוגדר, ראה למטה),
   - ולדף ג'רביס / לאפליקציה, ששם הוא **מוקרא בקול** ברגע שהם פתוחים.

לשנות שעה: `BRIEFING_HOUR` ב-`wrangler.toml`.
להריץ עכשיו: להגיד לג'רביס "תדריך בוקר", או לשלוח `/briefing` לבוט בטלגרם,
או `POST https://<worker>/briefing/run`.

## 5. טלגרם (אופציונלי, חינם)

1. בטלגרם: `@BotFather` ← `/newbot` ← קבל טוקן.
2. ```bash
   wrangler secret put TELEGRAM_BOT_TOKEN
   wrangler deploy
   ```
3. פתח `https://<worker>/telegram/setup` בדפדפן (רושם את ה-webhook).
4. שלח `/id` לבוט, קבל את המספר שלך, ואז:
   ```bash
   wrangler secret put OWNER_ID
   ```
   מעכשיו הבוט עונה רק לך, עם כל הכלים: זיכרון, תזכורות, יומן, מיילים, חיפוש.

## מה זה עולה

| רכיב | עלות |
|---|---|
| Google Gmail + Calendar API | חינם |
| Cloudflare Workers, D1, Cron | חינם (Free tier) |
| Telegram Bot API | חינם |
| Claude API | לפי טוקנים. תדריך בוקר אחד ≈ 10-20K טוקנים ביום. |

## אבטחה

- ג'רביס **אף פעם לא שולח מייל לבד**. תדריך הבוקר יוצר טיוטות בלבד; `gmail_send` רץ רק כשאתה אומר "שלח" בשיחה.
- תוכן של מיילים נכנס לסוכן כ-data לא כהוראות (עטוף ב-`untrusted_tool_result`).
- ה-refresh token נשמר ב-D1 שלך בלבד. ניתוק: `POST /google/disconnect` או הסרת הגישה ב-<https://myaccount.google.com/permissions>.
