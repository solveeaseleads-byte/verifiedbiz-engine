
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- WhatsApp send helper -------------------------------------------------
// NOTE: fixed domain — the correct Meta Graph API host is graph.facebook.com,
// not graph.facebook.net (that typo was silently breaking the original
// dispatch-alert call too).
async function sendWhatsAppMessage(toNumber, body) {
  return axios.post(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'text',
      text: { body }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

function generateOtp() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4-digit code
}

// --- Phone normalization ---------------------------------------------------
// WhatsApp Cloud API expects E.164 digits with no leading '+', spaces, or
// leading zeros after the country code (e.g. "2348001234567"). This is a
// permissive best-effort normalizer, not full E.164 validation — swap in a
// library like libphonenumber-js if you need to support ambiguous local
// formats across many countries.
function normalizePhoneNumber(raw) {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

// --- OTP send rate limiting -------------------------------------------------
// In-memory limiter: fine for a single instance, but resets on restart and
// won't be shared across multiple server processes/instances. Swap for a
// Supabase-backed or Redis-backed counter if you scale beyond one instance.
const otpRateState = new Map(); // phoneNumber -> { lastSentAt, sentInWindow: [] }
const OTP_MIN_INTERVAL_MS = 60 * 1000;       // 1 send per 60s
const OTP_WINDOW_MS = 60 * 60 * 1000;        // rolling 1 hour window
const OTP_MAX_PER_WINDOW = 5;                 // max 5 sends per hour per number

function checkOtpRateLimit(phoneNumber) {
  const now = Date.now();
  const state = otpRateState.get(phoneNumber) || { lastSentAt: 0, sentInWindow: [] };

  if (now - state.lastSentAt < OTP_MIN_INTERVAL_MS) {
    return { allowed: false, reason: 'Please wait before requesting another code.' };
  }

  state.sentInWindow = state.sentInWindow.filter(ts => now - ts < OTP_WINDOW_MS);
  if (state.sentInWindow.length >= OTP_MAX_PER_WINDOW) {
    return { allowed: false, reason: 'Too many codes requested for this number. Try again later.' };
  }

  state.lastSentAt = now;
  state.sentInWindow.push(now);
  otpRateState.set(phoneNumber, state);
  return { allowed: true };
}

// --- Send OTP --------------------------------------------------------------
app.post('/api/send-otp', async (req, res) => {
  const rawPhone = req.body.phoneNumber;
  const phoneNumber = normalizePhoneNumber(rawPhone);
  if (!phoneNumber) {
    return res.status(400).json({ success: false, error: 'Enter a valid phone number with country code.' });
  }

  const rateCheck = checkOtpRateLimit(phoneNumber);
  if (!rateCheck.allowed) {
    return res.status(429).json({ success: false, error: rateCheck.reason });
  }

  const code = generateOtp();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minute expiry

  try {
    const { error: dbError } = await supabase
      .from('otp_codes')
      .insert([{ phone_number: phoneNumber, code, expires_at: expiresAt }]);

    if (dbError) throw dbError;

    await sendWhatsAppMessage(
      phoneNumber,
      `Your VerifiedBiz Engine verification code is *${code}*. It expires in 5 minutes.`
    );

    res.status(200).json({ success: true, normalizedPhone: phoneNumber });
  } catch (err) {
    console.error('send-otp error:', err.message);
    // Honest failure — no fake success here.
    res.status(500).json({ success: false, error: 'Could not send verification code. Please try again.' });
  }
});

// --- Verify OTP + create/link account --------------------------------------
app.post('/api/verify-otp', async (req, res) => {
  const { code, fullName, email } = req.body;
  const phoneNumber = normalizePhoneNumber(req.body.phoneNumber);
  if (!phoneNumber || !code || !fullName || !email) {
    return res.status(400).json({ success: false, error: 'Missing information.' });
  }

  try {
    const { data: otpRow, error: fetchError } = await supabase
      .from('otp_codes')
      .select('*')
      .eq('phone_number', phoneNumber)
      .eq('consumed', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (fetchError || !otpRow) {
      return res.status(400).json({ success: false, error: 'No pending code for this number. Request a new one.' });
    }

    if (new Date(otpRow.expires_at) < new Date()) {
      return res.status(400).json({ success: false, error: 'Code expired. Request a new one.' });
    }

    if (otpRow.attempts >= 5) {
      return res.status(429).json({ success: false, error: 'Too many attempts. Request a new code.' });
    }

    if (otpRow.code !== code) {
      await supabase
        .from('otp_codes')
        .update({ attempts: otpRow.attempts + 1 })
        .eq('id', otpRow.id);
      return res.status(400).json({ success: false, error: 'Incorrect code.' });
    }

    // Correct code — consume it and upsert the account.
    await supabase.from('otp_codes').update({ consumed: true }).eq('id', otpRow.id);

    const { data: account, error: upsertError } = await supabase
      .from('accounts')
      .upsert(
        { full_name: fullName, email, phone_number: phoneNumber, phone_verified: true },
        { onConflict: 'email' }
      )
      .select()
      .single();

    if (upsertError) throw upsertError;

    res.status(200).json({ success: true, account });
  } catch (err) {
    console.error('verify-otp error:', err.message);
    res.status(500).json({ success: false, error: 'Verification failed. Please try again.' });
  }
});

// --- Dispatch webhook (fixed domain, unchanged logic otherwise) -----------
app.post('/api/whatsapp-webhook', async (req, res) => {
  const { serviceId, clientName, dispatchAddress, requestId } = req.body;

  if (!serviceId || !clientName || !dispatchAddress) {
    return res.status(400).json({ error: 'Missing information!' });
  }

  try {
    // Idempotency: if the client sent a requestId we've already logged
    // (e.g. a retried fetch or a double-click), return the existing job
    // instead of creating a duplicate dispatch.
    if (requestId) {
      const { data: existing } = await supabase
        .from('dispatches')
        .select('*')
        .eq('request_id', requestId)
        .maybeSingle();

      if (existing) {
        return res.status(200).json({ success: true, jobId: existing.id, deduped: true });
      }
    }

    const { data: job, error: dbError } = await supabase
      .from('dispatches')
      .insert([
        {
          service_id: serviceId,
          client_name: clientName,
          dispatch_address: dispatchAddress,
          status: 'PENDING_PROVIDER',
          request_id: requestId || null
        }
      ])
      .select()
      .single();

    if (dbError) throw dbError;

    const messageBody =
      `🚀 *NEW AUTOMATED DISPATCH ALERT*\n\n` +
      `• *Job ID:* #${job.id}\n` +
      `• *Service:* ${serviceId}\n` +
      `• *Client Name:* ${clientName}\n` +
      `• *Location:* ${dispatchAddress}\n\n` +
      `Reply *ACCEPT ${job.id}* to claim this job!`;

    await sendWhatsAppMessage(process.env.DISPATCH_ALERT_PHONE, messageBody);

    res.status(200).json({ success: true, jobId: job.id });
  } catch (err) {
    console.error('whatsapp-webhook error:', err.message);
    // Honest failure returned to the client — the front-end must not
    // paper over this with a fake success message.
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Engine running on port ${PORT}`));
