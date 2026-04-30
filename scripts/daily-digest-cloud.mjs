#!/usr/bin/env node
/**
 * Cloud-native daily digest — runs on GitHub Actions.
 * Reads local feeds (updated by generate-feed.yml), generates digest via NVIDIA API,
 * and sends via Resend. No Chrome CDP needed — cloud has direct internet access.
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config from env (set in GitHub Secrets)
// ---------------------------------------------------------------------------

function loadConfig() {
  return {
    nvidiaApiKey: process.env.NVIDIA_API_KEY,
    nvidiaModel: 'qwen/qwen3-next-80b-a3b-instruct',
    nvidiaBaseUrl: 'https://integrate.api.nvidia.com/v1',
    resendApiKey: process.env.RESEND_API_KEY,
    emailTo: process.env.EMAIL_TO || 'olivia.chen902@gmail.com'
  };
}

// ---------------------------------------------------------------------------
// Load feeds & prompts from repo (already updated by generate-feed.yml)
// ---------------------------------------------------------------------------

async function loadFeeds() {
  const dir = join(SCRIPT_DIR, '..');
  const [x, podcasts, blogs] = await Promise.all([
    readFile(join(dir, 'feed-x.json'), 'utf-8').then(JSON.parse).catch(() => null),
    readFile(join(dir, 'feed-podcasts.json'), 'utf-8').then(JSON.parse).catch(() => null),
    readFile(join(dir, 'feed-blogs.json'), 'utf-8').then(JSON.parse).catch(() => null)
  ]);
  return { x, podcasts, blogs };
}

async function loadPrompts() {
  const dir = join(SCRIPT_DIR, '..', 'prompts');
  const files = {
    intro: 'digest-intro.md',
    tweets: 'summarize-tweets.md',
    podcasts: 'summarize-podcast.md',
    blogs: 'summarize-blogs.md'
  };
  const out = {};
  for (const [k, f] of Object.entries(files)) {
    try { out[k] = await readFile(join(dir, f), 'utf-8'); }
    catch (e) { out[k] = ''; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Format data for the prompt
// ---------------------------------------------------------------------------

function formatTweets(users) {
  const lines = [];
  for (const u of (users || []).slice(0, 8)) {
    const tweets = (u.tweets || [])
      .sort((a, b) => (b.likes || 0) - (a.likes || 0))
      .slice(0, 2);
    if (tweets.length === 0) continue;
    lines.push(`\n### ${u.name} (${u.handle}) — ${u.bio?.replace(/\n/g, ' ').slice(0, 100) || ''}`);
    for (const t of tweets) {
      lines.push(`- [${t.likes || 0} likes] ${t.text?.replace(/\n/g, ' ')}`);
      lines.push(`  URL: ${t.url}`);
    }
  }
  return lines.join('\n');
}

function formatPodcasts(podcasts) {
  const lines = [];
  for (const p of (podcasts || []).slice(0, 3)) {
    lines.push(`\n### ${p.name} — "${p.title}"`);
    lines.push(`URL: ${p.url}`);
    const tx = p.transcript || '';
    lines.push(`Transcript (first 1500 chars): ${tx.replace(/\n/g, ' ').slice(0, 1500)}`);
  }
  return lines.join('\n');
}

function formatBlogs(blogs) {
  const lines = [];
  for (const b of (blogs || []).slice(0, 5)) {
    lines.push(`\n- ${b.title} by ${b.author || 'Unknown'}`);
    lines.push(`  URL: ${b.url}`);
    if (b.summary) lines.push(`  Summary: ${b.summary}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Generate digest via NVIDIA API
// ---------------------------------------------------------------------------

async function generateDigest(feeds, prompts, cfg) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const systemPrompt = `${prompts.intro}

CRITICAL: The user wants a BILINGUAL digest (Chinese + English).
For each section, provide BOTH languages:
- Chinese first, then English
- Or interleave: Chinese paragraph followed by English paragraph
Make it natural and readable for a bilingual audience.`;

  const userPrompt = `Today's date: ${today}

## X / TWITTER
${formatTweets(feeds.x?.x)}

## PODCASTS
${formatPodcasts(feeds.podcasts?.podcasts)}

## BLOGS
${formatBlogs(feeds.blogs?.blogs)}

Please generate the complete digest following the format and rules in the system prompt.
Include source links for every piece of content.
End with: "Generated through the Follow Builders skill: https://github.com/zarazhangrui/follow-builders"`;

  console.log('[Digest] Calling NVIDIA API...');
  const res = await fetch(`${cfg.nvidiaBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.nvidiaApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: cfg.nvidiaModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.5,
      max_tokens: 4096
    })
  });

  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(`NVIDIA API error: ${json.error?.message || JSON.stringify(json).slice(0, 200)}`);
  }
  return json.choices[0].message.content;
}

// ---------------------------------------------------------------------------
// Send email via Resend
// ---------------------------------------------------------------------------

async function sendEmail(text, cfg) {
  const subject = `AI Builders Digest — ${new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  })}`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.resendApiKey}`
    },
    body: JSON.stringify({
      from: 'AI Builders Digest <digest@resend.dev>',
      to: [cfg.emailTo],
      subject: subject,
      text: text
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Resend API error: ${err.message || JSON.stringify(err)}`);
  }
  const data = await res.json();
  console.log(`[Email] Sent to ${cfg.emailTo}, id: ${data.id}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('[1/4] Loading config...');
  const cfg = loadConfig();
  if (!cfg.nvidiaApiKey) throw new Error('NVIDIA_API_KEY not set');
  if (!cfg.resendApiKey) throw new Error('RESEND_API_KEY not set');

  console.log('[2/4] Loading feeds & prompts...');
  const [feeds, prompts] = await Promise.all([loadFeeds(), loadPrompts()]);
  const xCount = feeds.x?.x?.length || 0;
  const pCount = feeds.podcasts?.podcasts?.length || 0;
  const bCount = feeds.blogs?.blogs?.length || 0;
  console.log(`    ${xCount} X users, ${pCount} podcasts, ${bCount} blogs`);

  console.log('[3/4] Generating digest...');
  const digest = await generateDigest(feeds, prompts, cfg);
  console.log(`    Generated ${digest.length} chars`);

  console.log('[4/4] Sending email...');
  await sendEmail(digest, cfg);
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
