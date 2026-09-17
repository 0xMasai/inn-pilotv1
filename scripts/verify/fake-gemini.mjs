// A scripted stand-in for the Gemini REST API, for browser verification when
// the real model's quota is spent. It replaces ONLY the model: the UI, the
// gateway, the tools, the booking transaction and Firestore are all real.
//
//   node scripts/verify/fake-gemini.mjs            # listens on :8787
//   GEMINI_BASE_URL=http://127.0.0.1:8787 npm run dev:api
//
// It follows the golden path: dates + "double" → search_hotels; "option N" →
// ask for name and phone; a phone number → prepare_booking; a clear yes →
// create_reservation. Every figure it says comes from the tool results the
// gateway sends back, exactly as the real model is instructed to do.
import http from "node:http";

const PORT = Number(process.env.FAKE_GEMINI_PORT ?? 8787);
const memory = { options: [], summary: null };

const text = (value) => ({ candidates: [{ content: { role: "model", parts: [{ text: value }] }, finishReason: "STOP" }], usageMetadata: {} });
const call = (name, args) => ({
  candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] }, finishReason: "STOP" }],
  usageMetadata: {},
});
const ugx = (n) => `UGX ${Number(n).toLocaleString("en-US")}`;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function stayFrom(message) {
  const month = MONTHS.findIndex((m) => message.toLowerCase().includes(m));
  const days = [...message.matchAll(/(\d{1,2})(?:st|nd|rd|th)?/g)].map((m) => Number(m[1])).filter((d) => d >= 1 && d <= 31);
  if (month < 0 || days.length < 2) return null;
  const now = new Date();
  let year = now.getUTCFullYear();
  if (new Date(Date.UTC(year, month, days[0])) < now) year += 1;
  const iso = (d) => `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { checkIn: iso(days[0]), checkOut: iso(days[1]) };
}

function respond(body) {
  const contents = body.contents ?? [];
  const last = contents.at(-1) ?? { parts: [] };
  const toolResult = last.parts.find((part) => part.functionResponse)?.functionResponse;

  if (toolResult) {
    const r = toolResult.response ?? {};
    if (toolResult.name === "search_hotels") {
      if (r.status !== "ok") return text(r.guidance ?? r.message ?? "I couldn't find anything for those dates.");
      memory.options = r.options;
      const lines = r.options.map((o) => `${o.optionNumber}. ${o.hotelName} (${o.city}) — ${o.roomType}, ${ugx(o.nightlyRate)}/night, ${o.nights} nights: ${ugx(o.stayTotal)}`);
      return text(`Here are ${r.options.length} available options:\n${lines.join("\n")}\n\nWhich one would you like?`);
    }
    if (toolResult.name === "prepare_booking") {
      if (r.status !== "ready") return text(r.message ?? "I need a few more details.");
      memory.summary = r.summary;
      const s = r.summary;
      return text(`**BOOKING SUMMARY**\n- Hotel: ${s.hotelName}\n- Room: ${s.roomType}\n- Check-in: ${s.checkIn}\n- Check-out: ${s.checkOut}\n- Nights: ${s.nights}\n- Guest: ${s.guestName}\n- Total: ${ugx(s.totalPrice)}\n\nWould you like me to confirm this booking?`);
    }
    if (toolResult.name === "create_reservation") {
      if (r.status !== "confirmed") return text(r.message ?? "That couldn't be booked.");
      const b = r.booking;
      return text(`Booking confirmed. Your reference is **${b.reservationId}** — ${b.roomType} at ${b.hotelName}, ${b.checkIn} to ${b.checkOut}, total ${ugx(b.totalPrice)}. Payment is settled with the hotel.`);
    }
    return text("Done.");
  }

  const userText = last.parts.map((part) => part.text ?? "").join(" ");
  const allUserText = contents.filter((c) => c.role === "user").map((c) => c.parts.map((p) => p.text ?? "").join(" ")).join("\n");

  const stay = stayFrom(userText);
  if (stay) {
    const destination = /western uganda/i.test(userText) ? "Western Uganda" : "";
    const roomType = /double/i.test(userText) ? "Double" : "";
    return call("search_hotels", { ...stay, ...(destination ? { destination } : {}), ...(roomType ? { roomType } : {}) });
  }
  if (/option \d+/i.test(userText)) {
    return text("Great choice. May I have your full name and phone number?");
  }
  const phone = userText.match(/\+?\d[\d\s()-]{6,}\d/);
  if (phone) {
    const chosen = Number((allUserText.match(/option (\d+)/gi) ?? []).at(-1)?.match(/\d+/)?.[0] ?? 1);
    const option = memory.options.find((o) => o.optionNumber === chosen);
    if (!option) return text("Which option would you like?");
    const name = userText.slice(0, phone.index).replace(/[,.\s]+$/, "").trim();
    const search = memory.options[0];
    return call("prepare_booking", {
      hotel: option.hotel,
      roomType: option.roomType,
      checkIn: memory.checkIn ?? search.checkIn,
      checkOut: memory.checkOut ?? search.checkOut,
      guestName: name,
      guestPhoneNumber: phone[0].trim(),
      numberOfGuests: 1,
    });
  }
  if (/\b(yes|confirm)\b/i.test(userText) && memory.summary) {
    const s = memory.summary;
    return call("create_reservation", {
      hotel: s.hotel,
      roomType: s.roomType,
      checkIn: s.checkIn,
      checkOut: s.checkOut,
      guestName: s.guestName,
      guestPhoneNumber: s.guestPhone,
    });
  }
  return text("Where and when would you like to stay?");
}

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let payload;
      try {
        const body = JSON.parse(raw || "{}");
        // search_hotels results don't carry dates per option; remember them from the call.
        for (const content of body.contents ?? []) {
          for (const part of content.parts ?? []) {
            if (part.functionCall?.name === "search_hotels") {
              memory.checkIn = part.functionCall.args.checkIn;
              memory.checkOut = part.functionCall.args.checkOut;
            }
          }
        }
        payload = respond(body);
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: 500, message: String(error) } }));
        return;
      }
      console.log(`[fake-gemini] ${req.url} → ${payload.candidates[0].content.parts[0].functionCall?.name ?? "text"}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  })
  .listen(PORT, () => console.log(`fake Gemini on http://127.0.0.1:${PORT}`));
