# JARVIS relay

<div dir="rtl">

## מה זה

כדי לשלוט במחשב מהנייד כשאתה לא בבית, צריך משהו באמצע: הנייד לא יכול להגיע
למחשב שלך ישירות דרך האינטרנט. הממסר הזה הוא החוליה הזו.

**הוא לא יכול לשלוט במחשב שלך.** כל הודעה שעוברת דרכו מוצפנת מקצה לקצה במפתח
שרק הנייד והמחשב מכירים, וחתומה בחתימה שרק הם יכולים לייצר. הממסר רואה רק גוש
בייטים אטום ומזהה חדר אקראי. הוא יכול לעכב או להפיל הודעה. הוא לא יכול לקרוא
אותה, לזייף פקודה, או לאשר פעולה.

## העלות

חינם. התוכנית החינמית של Cloudflare Workers נותנת 100,000 בקשות ליום. מחשב אחד
שמחובר כל הזמן צורך בערך 3,500 ביום.

## התקנה — פעם אחת

```bash
cd relay
npx wrangler deploy
```

בסיום תקבל כתובת כמו `https://jarvis-relay.<השם-שלך>.workers.dev`.
הכנס אותה בהגדרות ג'רביס, בשדה "כתובת הממסר", והפעל את המתג.

זהו. אין מפתחות, אין חשבון בתשלום, אין מה להגדיר עוד.

## איך לכבות

תכבה את המתג בהגדרות, או `npx wrangler delete`. ברגע שהמתג כבוי, המחשב מפסיק
להתחבר החוצה והשליטה מרחוק נעצרת מיידית.

</div>

---

## Protocol

Four endpoints, all under `/r/:room/`. `room` is 32 hex characters generated on
the PC; it is a routing key, not a credential.

| Endpoint | Caller | Purpose |
| --- | --- | --- |
| `GET /r/:room/poll` | agent | Long-poll, held up to 25s, returns queued sealed messages |
| `POST /r/:room/reply` | agent | Deliver the sealed reply for one message id |
| `POST /r/:room/send` | phone | Enqueue a sealed envelope, wait up to 30s for the reply |
| `GET /r/:room/presence` | phone | Whether the agent has polled recently |

The relay stores nothing durably and holds at most 16 queued messages for 60
seconds. Anyone who learns a room id can make the agent do useless work and can
deny service; they cannot read traffic or issue commands, because the agent
rejects any envelope whose HMAC signature does not verify against the paired
device's secret.
