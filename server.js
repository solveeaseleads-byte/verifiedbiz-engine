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

app.post('/api/whatsapp-webhook', async (req, res) => {
  const { serviceId, clientName, dispatchAddress } = req.body;

  if (!serviceId || !clientName || !dispatchAddress) {
    return res.status(400).json({ error: 'Missing information!' });
  }

  try {
    const { data: job, error: dbError } = await supabase
      .from('dispatches')
      .insert([
        {
          service_id: serviceId,
          client_name: clientName,
          dispatch_address: dispatchAddress,
          status: 'PENDING_PROVIDER'
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

    await axios.post(
      `https://graph.facebook.net/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: process.env.DISPATCH_ALERT_PHONE,
        type: 'text',
        text: { body: messageBody }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.status(200).json({ success: true, jobId: job.id });

  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Engine running on port ${PORT}`));
