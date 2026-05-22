/**
 * QA seed — creates 3 synthetic AI startup applications for manual validation.
 *
 * Usage: npx tsx src/seed/qa-applications.ts
 *
 * Applications:
 *  1. STRONG   — should score ≥ 70 and reach "priority" band
 *  2. BORDERLINE — should score 38–55 and reach "passed_with_gaps" or "not_passed"
 *  3. WEAK     — should score < 40 and be rejected or trigger a knockout
 */

import { connectDb, disconnectDb } from '../db';
import { Application } from '../models/Application';
import { Submission } from '../models/Submission';

const QA_APPS = [
  {
    tag: 'STRONG',
    application: {
      email: 'qa-strong@igaps-test.dev',
      founderName: 'Arjun Mehta',
      startupName: 'HealthLens AI',
      linkedinUrl: 'https://linkedin.com/company/healthlens-ai',
      websiteUrl: 'https://healthlens.ai',
      cinNumber: 'U72900KA2022PTC145678',
      githubUrl: 'https://github.com/healthlens-ai',
      sectorTag: 'ai' as const,
      status: 'questionnaire_open' as const,
    },
    closedAnswers: {
      closedQ1: 'operator',
      closedQ2: 60,
      closedQ3: 36,
      closedQ4: ['worked_together', 'built_startup_together'],
      closedQ5: 'professional_network',
      closedQ6: 0,
      closedQ7: 'yes',
      closedQ7_count: 1,
      closedQ8: 45,
      closedQ9: 'specific_role',
      closedQ10: 'Enterprise',
      closedQ11: 'yes_high',
      closedQ12: 'provided_with_source',
      closedQ13: '6',
      closedQ14: ['performance', 'compliance'],
      closedQ15: '10x_to_50x',
      closedQ16: ['proprietary_data', 'regulatory_advantage'],
      closedQ17: 'paying_customers',
      closedQ18: 'strong',
    },
    openAnswers: {
      openQ1: 'I spent five years as a radiologist at Manipal Hospital. Every day I would spend 3–4 hours reporting CT scans that could have been screened by an AI triage layer. I saw colleagues miss early-stage tumours not from incompetence but from fatigue at hour seven of a twelve-hour shift. I built HealthLens because I was the customer. I have read 40,000 scans. That dataset is in my head, and now it is in our model.',
      openQ2: 'The thing no outsider sees: radiology AI fails in India not because the models are bad but because DICOM metadata from tier-2 hospitals is catastrophically inconsistent. Every hospital has a different modality vendor with a different tag structure. The model never sees clean data. We solved this with a metadata normalisation layer that took 18 months. That layer is our moat, not the AI.',
      openQ3: 'In the next 30 days I can call Dr Sanjay Rao, Head of Radiology at Apollo Chennai — he is my residency mentor — and get a letter of intent before any competitor can even get a meeting. I can also access a de-identified dataset from three Manipal hospitals under an existing research agreement I signed in 2021.',
      openQ4: 'The person most affected is Dr Priya Nair — 34, working a 14-hour shift at a 500-bed government hospital in Coimbatore. She reports 200 chest X-rays per day. She told me: "By scan 150, I am not sure I am seeing anything anymore. I pray the AI was right." The problem is not volume. It is the cognitive load of uncertainty at the end of a long shift.',
      openQ5: 'I spoke to 47 radiologists across 12 hospitals over 8 months. The most surprising finding was that 3 of the 5 radiologists who said they would never use AI were already using a competitor tool informally because their hospital had not approved it. They were the most eager buyers. That insight changed our go-to-market from enterprise-top-down to grassroots-radiologist-first.',
      openQ6: 'The gap is not detection accuracy — existing tools are good enough. The gap is the absence of a radiologist-grade uncertainty score. Every radiologist told us they do not trust a binary output. They want to know how confident the model is and why. No existing tool surfaces calibrated uncertainty in plain language.',
      openQ7: 'A radiologist using RadAssist today tells us they still have to double-check every flagged scan because the false positive rate is 18%. With HealthLens they check only the scans our model is uncertain about — which is 12% of volume — and trust the high-confidence outputs. That is a 35% reduction in review burden per shift.',
      openQ8: 'The hardest problem was building a DICOM normalisation pipeline that works across 40 different modality firmware versions. No one else has done this because it requires clinical knowledge to validate the mapping — you cannot outsource it to engineers. A well-funded competitor would need 2 years and at least one radiology-trained engineer on staff.',
      openQ9: 'We originally built a CT-first product because CT has the highest signal density. We found out six months in that the procurement cycle for CT AI in India is 18 months and requires CDSCO approval. We pivoted to chest X-ray — same technical architecture, faster procurement, CE-marked equivalent. We pivoted in 6 weeks.',
      openQ10: 'We have three paying customers: Apollo Hospitals (annual contract ₹28L), a Manipal satellite clinic, and a private teleradiology firm. Apollo renewed after a 3-month pilot. We did not approach them — they approached us after our head of radiology published a case study.',
    },
  },
  {
    tag: 'BORDERLINE',
    application: {
      email: 'qa-borderline@igaps-test.dev',
      founderName: 'Meera Krishnan',
      startupName: 'SupplyMind',
      linkedinUrl: 'https://linkedin.com/company/supplymind',
      websiteUrl: 'https://supplymind.io',
      cinNumber: 'L74999MH2023PTC299100',
      githubUrl: undefined,
      sectorTag: 'ai' as const,
      status: 'questionnaire_open' as const,
    },
    closedAnswers: {
      closedQ1: 'neither',
      closedQ2: 12,
      closedQ3: 6,
      closedQ4: ['met_through_network'],
      closedQ5: 'cold_outreach',
      closedQ6: 3000,
      closedQ7: 'no',
      closedQ8: 15,
      closedQ9: 'category_only',
      closedQ10: 'SME',
      closedQ11: 'yes_medium',
      closedQ12: 'provided_no_source',
      closedQ13: '4',
      closedQ14: ['workflow', 'price'],
      closedQ15: '2x_to_5x',
      closedQ16: ['workflow_integration', 'switching_costs'],
      closedQ17: 'pilots_lois',
      closedQ18: 'moderate',
    },
    openAnswers: {
      openQ1: 'I read an article about supply chain disruptions during COVID and thought there was an opportunity for AI-powered demand forecasting for SMEs. I spent about a year reading about the space and talking to some people before starting.',
      openQ2: 'SMEs often do not have the time or resources to properly analyse their supply chain data. They need a simple, affordable tool.',
      openQ3: 'We can reach out to our existing network of SME contacts and potentially get them interested in a pilot.',
      openQ4: 'Small business owners struggle to manage inventory effectively. They often either overstock or run out of key items, which costs them money. Our persona is a typical SME owner in manufacturing.',
      openQ5: 'We spoke to about 15 small business owners. Most of them said they had inventory problems and were interested in a solution. We also spoke to a few consultants.',
      openQ6: 'Current tools like Excel are too manual and enterprise software is too expensive. There is a gap in the middle for affordable AI-powered forecasting.',
      openQ7: 'Our product is easier to use than enterprise tools and cheaper. An SME owner would switch because they would save money and time.',
      openQ8: 'The main challenge is cleaning and normalising data from different ERP systems. We have built a basic integration layer that handles this.',
      openQ9: 'We initially thought we would sell to retailers but found they already had solutions. We pivoted to manufacturing SMEs which seemed more underserved.',
      openQ10: 'We have two pilot LOIs signed and have had good feedback from potential customers who expressed strong interest in the product.',
    },
  },
  {
    tag: 'WEAK',
    application: {
      email: 'qa-weak@igaps-test.dev',
      founderName: 'Rahul Singh',
      startupName: 'GenAI Platform Co',
      linkedinUrl: 'https://linkedin.com/company/genai-platform',
      websiteUrl: 'https://genaiplatform.com',
      cinNumber: 'U72200DL2024PTC410000',
      githubUrl: undefined,
      sectorTag: 'ai' as const,
      status: 'questionnaire_open' as const,
    },
    closedAnswers: {
      closedQ1: 'neither',
      closedQ2: 0,        // K1a knockout fires here
      closedQ3: 0,
      closedQ4: ['no_prior_relationship'],
      closedQ5: 'cold_outreach',
      closedQ6: 8000,
      closedQ7: 'no',
      closedQ8: 0,        // K2: zero discovery
      closedQ9: 'category_only',
      closedQ10: 'Enterprise',
      closedQ11: 'no',
      closedQ12: 'not_provided',
      closedQ13: '1',     // K2: TRL 1
      closedQ14: ['price'],
      closedQ15: 'less_than_2x',
      closedQ16: ['brand_trust'],
      closedQ17: 'early_conversations',   // K2: earliest stage
      closedQ18: 'none',
    },
    openAnswers: {
      openQ1: 'I saw ChatGPT and thought there was a big opportunity in enterprise AI. I quit my job and started building.',
      openQ2: 'Enterprises need AI but do not know how to use it effectively.',
      openQ3: 'We can move fast and build quickly.',
      openQ4: 'Enterprises want to use AI but do not have the tools or expertise.',
      openQ5: 'We have not done much customer discovery yet as we are still building.',
      openQ6: 'There is a gap between what AI can do and what enterprises are actually implementing.',
      openQ7: 'Our platform is easy to use and affordable.',
      openQ8: 'We are still working on the technical architecture.',
      openQ9: 'Not applicable yet.',
      openQ10: 'The market size for enterprise AI is very large according to Gartner.',
    },
  },
];

async function seedQA() {
  await connectDb();
  console.info('[QA Seed] Starting QA application seed…');

  for (const qa of QA_APPS) {
    const existing = await Application.findOne({ email: qa.application.email });
    if (existing) {
      console.info(`[QA Seed] ${qa.tag}: Application already exists — skipping`);
      continue;
    }

    const app = await Application.create(qa.application);
    await Submission.create({
      applicationId: app._id,
      closedAnswers: qa.closedAnswers,
      openAnswers: qa.openAnswers,
      uploads: [],
      scrapedData: {
        linkedin: 'unavailable',
        github: 'unavailable',
        zauba: 'unavailable',
        press: 'unavailable',
        patents: 'unavailable',
      },
      completedAt: new Date(),
    });

    console.info(`[QA Seed] ${qa.tag}: Created application ${app._id} (${qa.application.email})`);
  }

  console.info('[QA Seed] Done. Run the evaluation engine against these IDs to validate bands.');
  await disconnectDb();
  process.exit(0);
}

if (require.main === module) {
  seedQA().catch((err) => {
    console.error('[QA Seed] Fatal:', err);
    process.exit(1);
  });
}
