# ALUXÉ SMS Relay — Deploy Guide

## What this does
- Someone texts your Quo number → AI responds as Kevin (Brain v6)
- You text your own Quo number "Referral: Name, phone, context" → AI texts the lead for you
- Conversation history tracked per contact

## Step 1: Deploy to Railway (free, ~5 minutes)

1. Go to **railway.app** and sign up (use GitHub login)
2. Click **New Project → Deploy from GitHub repo**
   - Or use **Deploy from Local** if you want to upload directly
3. Drag and drop the `SMS Relay` folder OR connect your GitHub
4. Railway auto-detects Node.js and runs `npm start`

## Step 2: Set Environment Variables in Railway

In your Railway project dashboard → **Variables** tab, add these:

| Variable | Value |
|---|---|
| `OPENPHONE_API_KEY` | `d399ab6f8f51e62a309f625ae102301ddf72e6dbed900a4919d0c7e2bb02289e` |
| `QUO_PHONE_NUMBER` | `+16234002146` |
| `ANTHROPIC_API_KEY` | `sk-ant-api03-D1zinOpi5iJvPfe...` (your Anthropic key) |
| `KEVIN_PERSONAL_PHONE` | Your personal cell in +1XXXXXXXXXX format |

After saving variables, Railway will redeploy automatically.

## Step 3: Get your webhook URL

In Railway → your project → **Deployments** → copy the public URL.
It will look like: `https://aluxe-sms-relay-production.up.railway.app`

Your webhook URL is: `https://YOUR-URL.railway.app/webhook`

## Step 4: Set up OpenPhone/Quo webhook

1. Log into **quo.com** (or openphone.com)
2. Go to **Settings → Integrations → Webhooks**
3. Add webhook URL: `https://YOUR-URL.railway.app/webhook`
4. Select event: **Message Received**
5. Save

## Step 5: Test it

**Test AI reply:** Text your Quo number (+16234002146) from any phone.
You should get a response within 5-10 seconds.

**Test referral trigger:** From your personal phone, text your Quo number:
```
Referral: Sarah Johnson, +16025551234, friend said she wants lip filler
```
Within 10 seconds, Sarah will get a text from your Quo number, and you'll
get a confirmation showing what was sent.

## Referral trigger format

Always start with "Referral:" then:
- Name
- Phone number (+1XXXXXXXXXX or just 10 digits)
- Context (what they want, who referred them, etc.)

Example:
```
Referral: Maria Garcia, 6025558899, Jennifer's sister, interested in Botox and HydraFacial
```

## Verify it's running

Visit: `https://YOUR-URL.railway.app/health`
Should return: `{"status":"ok","ts":"..."}`
