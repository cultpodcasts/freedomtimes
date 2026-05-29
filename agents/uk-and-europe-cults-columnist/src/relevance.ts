import type { RelevanceResult } from './types.ts';
import { ALL_CULT_TERMS } from './cultTerms.ts';
import { EUROPE_REGION_TERMS, UK_REGION_TERMS } from './discoveryConfig.ts';
import { getCoerciveHarmTermsForLanguage, getReligiousGroupTermsForLanguage } from './pipelineTerms.ts';

const STRONG_CULT_KEYWORDS = ALL_CULT_TERMS;
const CONFIGURED_UK_TERMS = normalizeConfiguredTerms(UK_REGION_TERMS);
const CONFIGURED_EUROPE_TERMS = normalizeConfiguredTerms(EUROPE_REGION_TERMS);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeConfiguredTerms(terms: string[]): string[] {
  return terms
    .map((term) => term.trim().replace(/^"|"$/g, '').toLowerCase())
    .filter(Boolean);
}

function containsPhrase(text: string, phrase: string): boolean {
  const escaped = escapeRegExp(phrase.toLowerCase());
  const pattern = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  return pattern.test(text);
}

function includesAnyPhrase(text: string, terms: string[]): boolean {
  return terms.some((term) => containsPhrase(text, term));
}

export function evaluateRelevance(rawText: string, language?: string): RelevanceResult {
  const text = rawText.toLowerCase();
  const reasons: string[] = [];
  let confidence = 0;

  const hasCultSignal = includesAnyPhrase(text, STRONG_CULT_KEYWORDS);
  const hasReligiousGroupSignal = includesAnyPhrase(text, getReligiousGroupTermsForLanguage(language));
  const hasCoerciveHarmSignal = includesAnyPhrase(text, getCoerciveHarmTermsForLanguage(language));
  const hasLegalCultEquivalentSignal = hasReligiousGroupSignal && hasCoerciveHarmSignal;

  if (hasCultSignal || hasLegalCultEquivalentSignal) {
    confidence += 60;
    if (hasCultSignal) {
      reasons.push('Strong cult-related keywords detected');
    } else {
      reasons.push('Religious-group + coercive-harm framing detected (treated as cult-equivalent signal)');
    }
  } else {
    reasons.push('No strong cult-related keywords detected');
  }

  const hasUkSignal = includesAnyPhrase(text, CONFIGURED_UK_TERMS);
  const hasEuropeSignal = includesAnyPhrase(text, CONFIGURED_EUROPE_TERMS);

  if (hasUkSignal) {
    confidence += 30;
    reasons.push('UK geographic signal detected');
  }

  if (hasEuropeSignal) {
    confidence += 25;
    reasons.push('Europe geographic signal detected');
  }

  let region: 'UK' | 'Europe' | 'Unknown' = 'Unknown';
  if (hasUkSignal) {
    region = 'UK';
  } else if (hasEuropeSignal) {
    region = 'Europe';
  }

  const accepted = (hasCultSignal || hasLegalCultEquivalentSignal) && region !== 'Unknown' && confidence >= 75;

  return {
    accepted,
    region,
    confidence: Math.min(100, confidence),
    reasons,
  };
}
