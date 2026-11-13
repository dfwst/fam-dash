// Free sorting rules that run BEFORE Claude. Two jobs:
//   1. applyRules  — settle the obvious junk without an AI call
//   2. safetyCheck — after any sort, force must-see mail into bucket 3 + priority
//
// Bias: when in doubt, return null and let Claude decide. A rule should only
// fire when it is almost never wrong, because bucket 1 gets archived silently (M4+).
import type { ThreadFacts } from './gmail-parse.ts';

export type Sort = {
  bucket: 1 | 2 | 3;
  priority: boolean;
  category: string;
  summary: string;
  reason: string;
  group_key: string | null;
  by: 'rule' | 'ai' | 'fallback' | 'learned';
  model?: string;
};

// Always priority, never archived: declined payments, security, Resi (church livestream).
// Matched against subject + sender only (not preview text — "Bitcoin declined 6%" isn't a declined card).
export const PRIORITY_RX = new RegExp([
  '(payment|card|transaction|charge|autopay)[^\\n]{0,40}(declin|fail|unsuccessful|could not be processed)',
  '(declin|fail)[^\\n]{0,20}(payment|card|transaction|charge)',
  'unable to process (your )?payment',
  'security alert', 'suspicious', 'unusual (sign|activity)', '(new|unrecognized) sign-?in', 'sign-?in attempt',
  'password (was )?(changed|reset)',
  '\\bresi\\b', 'facebook access', 'access (is )?expir',
].join('|'), 'i');

// One-time login codes are useless minutes later — never a to-do
const OTP_RX = /(\b\d{4,8} is your (verification |security |login )?code|your (verification|security|login|one-time|sign-in) code|verification code)/i;

// Words that mean "a person or a bill might be behind this" — never junk these by rule
const CAREFUL_RX =
  /(invoice|past due|overdue|due (date|today|tomorrow)|payment|bill\b|statement|receipt|refund|order|ship|deliver|appointment|reservation|school|teacher|class|jupiter|church|serving|tax)/i;

const PORTAL_RX = /@([a-z0-9-]+\.)*(portal\.io|proposalviewer\.com)$/i;
const NEXTDOOR_RX = /@([a-z0-9-]+\.)*nextdoor\.com$/i;
const SURVEY_RX = /\b(survey|how did we do|rate your|tell us about your (visit|experience)|feedback on your)\b/i;

const rule = (bucket: 1 | 2 | 3, category: string, reason: string, f: ThreadFacts): Sort => ({
  bucket, priority: false, category, reason, group_key: null, by: 'rule',
  summary: f.snippet.slice(0, 140),
});

export function applyRules(f: ThreadFacts): Sort | null {
  const subjectFrom = `${f.subject} ${f.fromEmail}`;

  if (PRIORITY_RX.test(subjectFrom)) return null;       // must-see: let Claude summarize it
  if (f.lastFromMe) return null;                         // a conversation you're part of

  if (OTP_RX.test(f.subject))
    return rule(1, 'security_code', 'One-time code — expires in minutes', f);

  if (PORTAL_RX.test(f.fromEmail))
    return rule(1, 'ops_app', 'Portal.io mail — your ops app reads it', f);

  if (NEXTDOOR_RX.test(f.fromEmail))
    return rule(1, 'social', 'Nextdoor', f);

  if (CAREFUL_RX.test(f.subject)) return null;

  if (SURVEY_RX.test(f.subject) && f.hasUnsubscribe)
    return rule(1, 'survey', 'Survey request', f);

  if (f.labels.includes('CATEGORY_PROMOTIONS'))
    return rule(1, 'marketing', 'Gmail filed it under Promotions', f);

  if (f.labels.includes('CATEGORY_SOCIAL'))
    return rule(1, 'social', 'Gmail filed it under Social', f);

  return null;
}

export function safetyCheck(f: ThreadFacts, s: Sort): Sort {
  if (PRIORITY_RX.test(`${f.subject} ${f.fromEmail}`)) {
    return { ...s, bucket: 3, priority: true };
  }
  return s;
}
