/**
 * Definitions for all 18 closed-ended questions.
 * Drives both the frontend form renderer and backend validation.
 */

export type ClosedQType =
  | 'select_one'
  | 'select_many'
  | 'select_many_ranked'
  | 'number'
  | 'number_with_currency'
  | 'text'
  | 'boolean_branch';

export interface ClosedQOption {
  value: string;
  label: string;
}

export interface ClosedQuestion {
  id: string;          // maps to signalKey prefix in tree.yaml
  text: string;
  hint?: string;
  type: ClosedQType;
  options?: ClosedQOption[];
  min?: number;
  max?: number;
  unit?: string;
  required: boolean;
  /** If defined, this question only shows when the answer to `dependsOn.id` matches `dependsOn.value` */
  dependsOn?: { id: string; value: string };
  /** Sector-specific: show only for these sector tags */
  sectors?: string[];
}

export const CLOSED_QUESTIONS: ClosedQuestion[] = [
  {
    id: 'closedQ1',
    text: 'Before starting this venture, were you a customer of this problem, an operator in this industry, or neither?',
    type: 'select_one',
    required: true,
    options: [
      { value: 'customer', label: 'Customer — I personally experienced this problem' },
      { value: 'operator', label: 'Operator — I worked in this industry or adjacent to it' },
      { value: 'neither', label: 'Neither — I identified this opportunity from the outside' },
    ],
  },
  {
    id: 'closedQ2',
    text: 'How long were you exposed to this problem before starting the company?',
    hint: 'Enter 0 if you identified the problem after founding.',
    type: 'number',
    unit: 'months',
    min: 0,
    max: 600,
    required: true,
  },
  {
    id: 'closedQ3',
    text: 'How long have you known your co-founder?',
    hint: 'Enter 0 if you are a solo founder.',
    type: 'number',
    unit: 'months',
    min: 0,
    max: 600,
    required: true,
  },
  {
    id: 'closedQ4',
    text: 'What is the nature of your prior relationship with your co-founder?',
    hint: 'Select all that apply.',
    type: 'select_many',
    required: true,
    options: [
      { value: 'worked_together', label: 'Worked together at the same organisation' },
      { value: 'studied_together', label: 'Studied together' },
      { value: 'personal_relationship', label: 'Personal relationship (friend or family)' },
      { value: 'built_startup_together', label: 'Built a startup together previously' },
      { value: 'met_through_network', label: 'Met through a professional network or community' },
      { value: 'no_prior_relationship', label: 'No prior relationship' },
    ],
  },
  {
    id: 'closedQ5',
    text: 'What was the primary source of your first 10 customers?',
    type: 'select_one',
    required: true,
    options: [
      { value: 'personal_relationship', label: 'Personal relationship' },
      { value: 'professional_network', label: 'Professional network' },
      { value: 'community', label: 'Community (online or offline)' },
      { value: 'cold_outreach', label: 'Cold outreach' },
      { value: 'inbound', label: 'Inbound (website, social media, press)' },
      { value: 'partnerships', label: 'Partnerships or channel referrals' },
      { value: 'other', label: 'Other' },
    ],
  },
  {
    id: 'closedQ6',
    text: 'What was your customer acquisition cost (CAC) for your first 10 customers?',
    hint: 'Enter 0 if customers were acquired at zero direct cost.',
    type: 'number_with_currency',
    min: 0,
    required: true,
  },
  {
    id: 'closedQ7',
    text: 'Has your startup pivoted since founding?',
    type: 'boolean_branch',
    required: true,
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
  },
  {
    id: 'closedQ7_count',
    text: 'How many times have you pivoted?',
    type: 'number',
    min: 1,
    max: 20,
    required: true,
    dependsOn: { id: 'closedQ7', value: 'yes' },
  },
  {
    id: 'closedQ8',
    text: 'How many people have you spoken to as part of your customer discovery?',
    hint: 'Provide totals across all categories. Breakdown is optional.',
    type: 'number',
    min: 0,
    unit: 'total conversations',
    required: true,
  },
  {
    id: 'closedQ9',
    text: 'What is the primary job title or role of your target persona?',
    hint: 'Be as specific as possible — e.g. "Head of Compliance at an Indian private bank" rather than "finance professional".',
    type: 'select_one',
    required: true,
    options: [
      { value: 'specific_role', label: 'I can specify the exact role' },
      { value: 'category_only', label: 'I can only describe a broad category' },
    ],
  },
  {
    id: 'closedQ9_role_text',
    text: 'Enter the exact job title or role of your target persona',
    hint: 'e.g. "Head of Compliance at an Indian private bank"',
    type: 'text',
    required: true,
    dependsOn: { id: 'closedQ9', value: 'specific_role' },
  },
  {
    id: 'closedQ9_category_text',
    text: 'Describe the broad category of your target persona',
    hint: 'e.g. "mid-level finance professionals in regulated industries"',
    type: 'text',
    required: true,
    dependsOn: { id: 'closedQ9', value: 'category_only' },
  },
  {
    id: 'closedQ10',
    text: 'Where does your primary persona work?',
    type: 'select_one',
    required: true,
    options: [
      { value: 'Enterprise', label: 'Enterprise (200+ employees)' },
      { value: 'SME', label: 'SME (10–200 employees)' },
      { value: 'Micro', label: 'Micro business or individual (< 10 employees)' },
      { value: 'Govt', label: 'Government or public sector organisation' },
    ],
  },
  {
    id: 'closedQ11',
    text: 'Does your target persona currently spend money on workarounds or alternatives to solve this problem?',
    type: 'select_one',
    required: true,
    options: [
      { value: 'yes_high', label: 'Yes — they spend significantly (> ₹5L / $6,000 per year)' },
      { value: 'yes_medium', label: 'Yes — they spend moderately (₹50K–₹5L / $600–$6,000 per year)' },
      { value: 'yes_low', label: 'Yes — they spend a small amount (< ₹50K / $600 per year)' },
      { value: 'no', label: 'No — they currently do not spend on this problem' },
    ],
  },
  {
    id: 'closedQ12',
    text: 'What is the estimated number of potential target personas in your primary market?',
    hint: 'Please include the source of this estimate.',
    type: 'select_one',
    required: true,
    options: [
      { value: 'provided_with_source', label: 'I have an estimate with a cited source' },
      { value: 'provided_no_source', label: 'I have an estimate but no formal source' },
      { value: 'not_provided', label: 'I have not estimated this yet' },
    ],
  },
  {
    id: 'closedQ13',
    text: 'What is your current Technology Readiness Level (TRL)?',
    hint: 'TRL 1 = basic research; TRL 9 = fully deployed and proven system.',
    type: 'select_one',
    required: true,
    options: [
      { value: '1', label: 'TRL 1 — Basic research; concept only' },
      { value: '2', label: 'TRL 2 — Technology concept formulated' },
      { value: '3', label: 'TRL 3 — Experimental proof of concept' },
      { value: '4', label: 'TRL 4 — Technology validated in lab' },
      { value: '5', label: 'TRL 5 — Technology validated in relevant environment' },
      { value: '6', label: 'TRL 6 — Technology demonstrated in relevant environment' },
      { value: '7', label: 'TRL 7 — System prototype demonstrated in operational environment' },
      { value: '8', label: 'TRL 8 — System complete and qualified' },
      { value: '9', label: 'TRL 9 — Actual system proven in operational environment' },
    ],
  },
  {
    id: 'closedQ14',
    text: 'What are your two primary dimensions of competitive differentiation?',
    hint: 'Select exactly two.',
    type: 'select_many',
    required: true,
    options: [
      { value: 'price', label: 'Price — meaningfully lower cost' },
      { value: 'performance', label: 'Performance — better outcomes on a measurable metric' },
      { value: 'accessibility', label: 'Accessibility — reaches underserved segments' },
      { value: 'localisation', label: 'Localisation — optimised for a specific geography or language' },
      { value: 'workflow', label: 'Workflow — fits seamlessly into existing processes' },
      { value: 'speed', label: 'Speed — significantly faster time-to-outcome' },
      { value: 'simplicity', label: 'Simplicity — dramatically easier to use' },
      { value: 'compliance', label: 'Compliance — meets regulatory requirements existing solutions do not' },
      { value: 'other', label: 'Other' },
    ],
  },
  {
    id: 'closedQ15',
    text: 'What is the improvement multiple on your primary differentiation dimension compared to the best existing alternative?',
    type: 'select_one',
    required: true,
    options: [
      { value: 'less_than_2x', label: 'Less than 2×' },
      { value: '2x_to_5x', label: '2× to 5×' },
      { value: '5x_to_10x', label: '5× to 10×' },
      { value: '10x_to_50x', label: '10× to 50×' },
      { value: 'more_than_50x', label: 'More than 50×' },
    ],
  },
  {
    id: 'closedQ16',
    text: 'What is your primary source of competitive moat?',
    hint: 'Select all that apply and rank your top 2 by dragging them to the top.',
    type: 'select_many_ranked',
    required: true,
    options: [
      { value: 'proprietary_data', label: 'Proprietary data' },
      { value: 'deep_tech', label: 'Deep technology (patentable IP, novel algorithms)' },
      { value: 'network_effects', label: 'Network effects' },
      { value: 'workflow_integration', label: 'Workflow integration / switching costs' },
      { value: 'exclusive_partnerships', label: 'Exclusive partnerships or distribution' },
      { value: 'regulatory_advantage', label: 'Regulatory advantage or licence' },
      { value: 'brand_trust', label: 'Brand and trust' },
      { value: 'community', label: 'Community' },
    ],
  },
  {
    id: 'closedQ17',
    text: 'What is your current traction stage?',
    type: 'select_one',
    required: true,
    options: [
      { value: 'early_conversations', label: 'Early conversations or proof-of-concept discussions' },
      { value: 'pilots_lois', label: 'Active pilots or signed Letters of Intent (LOIs)' },
      { value: 'paying_customers', label: 'Paying customers (at least one)' },
      { value: 'recurring_revenue', label: 'Recurring revenue (MRR or ARR established)' },
      { value: 'scaled_revenue', label: 'Scaled revenue (demonstrable growth trajectory)' },
    ],
  },
  {
    id: 'closedQ18',
    text: 'What is your primary traction metric for your startup type?',
    hint: 'Select the metric most relevant to your business model.',
    type: 'select_one',
    required: true,
    options: [
      { value: 'strong', label: 'Strong — metric is established and growing consistently' },
      { value: 'moderate', label: 'Moderate — metric is established but early-stage' },
      { value: 'weak', label: 'Weak — metric exists but is nascent or inconsistent' },
      { value: 'none', label: 'None — I do not yet have a meaningful traction metric' },
    ],
  },
];
