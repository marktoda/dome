import type { RecallCorpus } from "../recall-quality";

const wiki = (path: string, title: string, body: string, type?: string) => ({
  path, title, body, category: "wiki", ...(type === undefined ? {} : { type }),
});

/** Sanitized, work-shaped lexical benchmark. No private vault text is copied. */
export const RECALL_V1_CORPUS = Object.freeze({
  schema: "dome.eval.recall-corpus/v1",
  version: "2026-07-11.1",
  floors: {
    relevantRecallAt5: 0.95,
    allTargetsSuccessAt5: 0.9,
    maxForbiddenHitsAt10: 0,
  },
  documents: Object.freeze([
    wiki("wiki/entities/alice-chen.md", "Alice Chen", "Alice Chen was promoted to vice president and now owns the platform organization. Her current priority is developer reliability.", "person"),
    wiki("wiki/entities/maya-patel.md", "Maya Patel", "Maya Patel's compensation review is Friday. Her priorities are equity alignment and a staff-level growth plan.", "person"),
    wiki("wiki/entities/jordan-lee.md", "Jordan Lee", "Jordan Lee leads enterprise sales. Follow up about the Acme renewal and the healthcare pipeline before Monday.", "person"),
    wiki("wiki/decisions/atlas-vendor.md", "Atlas vendor decision", "The Atlas team selected Northwind as the data warehouse vendor on June 12 because migration risk was lower. Priya approved the decision.", "decision"),
    wiki("wiki/decisions/pricing-model.md", "Pricing model decision", "The pricing council chose usage-based pricing for the automation tier. The decision followed the May customer study and was approved by Elena.", "decision"),
    wiki("wiki/decisions/october-launch.md", "October launch decision", "Project Apollo moved its public launch to October after the security review found unresolved audit work. Marcus made the final call.", "decision"),
    wiki("wiki/meetings/engineering-staff.md", "Engineering staff meeting", "Engineering staff agenda: platform reliability, Alice's ownership transition, and the database incident. Open question: who owns the migration runbook?", "meeting"),
    wiki("wiki/meetings/roadmap-review.md", "Roadmap review", "Roadmap review agenda: Apollo launch timing, Beacon beta capacity, and Cedar onboarding. Bring the security dependency list.", "meeting"),
    wiki("wiki/meetings/customer-council.md", "Customer council", "Customer council preparation: discuss usage pricing feedback, Acme renewal risk, and healthcare compliance requests. Elena presents research.", "meeting"),
    wiki("wiki/projects/apollo.md", "Project Apollo", "Apollo is yellow. October launch is planned; the security audit and migration rehearsal remain blocking. Marcus owns the go-live decision.", "project"),
    wiki("wiki/projects/beacon.md", "Project Beacon", "Beacon private beta has 18 teams. Capacity testing is complete, documentation is in progress, and the next milestone is July 29.", "project"),
    wiki("wiki/projects/cedar.md", "Project Cedar", "Cedar onboarding redesign is green. Prototype research finished; implementation starts Monday with Nina leading design.", "project"),
    wiki("wiki/syntheses/northstar-product.md", "Northstar product", "Northstar capacity planning targets 40 percent growth. Product requires regional failover before general availability."),
    wiki("wiki/syntheses/northstar-infrastructure.md", "Northstar infrastructure", "Northstar capacity planning found database headroom for 35 percent growth. Infrastructure recommends shard testing for regional failover."),
    wiki("wiki/syntheses/hiring-plan.md", "Hiring plan", "The hiring plan opens two reliability engineering roles in the third quarter. Alice owns the interview panel."),
    wiki("wiki/syntheses/budget-plan.md", "Budget plan", "The budget plan funds two reliability engineering hires in the third quarter and reserves contractor budget for observability."),
    wiki("wiki/syntheses/incident-review.md", "Incident review", "The database incident showed missing migration safeguards. The reliability action is an automated rollback rehearsal."),
    wiki("wiki/syntheses/reliability-roadmap.md", "Reliability roadmap", "The reliability roadmap schedules automated rollback rehearsal and migration runbook ownership for this quarter."),
    wiki("wiki/concepts/promotion-process.md", "Promotion process", "General promotion calibration guidance, review mechanics, and leveling principles."),
    wiki("wiki/meetings/weekly-open-items.md", "Weekly open items", "General priorities and open threads for weekly operations."),
  ]),
  queries: Object.freeze([
    { id: "people-alice-promotion", job: "people", question: "What was the outcome of Alice Chen's promotion?", relevantPaths: ["wiki/entities/alice-chen.md"], forbiddenPaths: ["wiki/concepts/promotion-process.md"] },
    { id: "people-alice-priority", job: "people", question: "What is Alice Chen focused on in platform reliability?", relevantPaths: ["wiki/entities/alice-chen.md"] },
    { id: "people-maya-comp", job: "people", question: "What are Maya Patel's compensation priorities?", relevantPaths: ["wiki/entities/maya-patel.md"], forbiddenPaths: ["wiki/meetings/weekly-open-items.md"] },
    { id: "people-maya-growth", job: "people", question: "What growth plan is Maya Patel discussing?", relevantPaths: ["wiki/entities/maya-patel.md"] },
    { id: "people-jordan-followup", job: "people", question: "What should I follow up with Jordan Lee about?", relevantPaths: ["wiki/entities/jordan-lee.md"] },
    { id: "people-jordan-pipeline", job: "people", question: "Which customer pipeline does Jordan Lee own?", relevantPaths: ["wiki/entities/jordan-lee.md"] },

    { id: "decision-atlas-choice", job: "decision-provenance", question: "Which vendor did Atlas select and why?", relevantPaths: ["wiki/decisions/atlas-vendor.md"] },
    { id: "decision-atlas-approver", job: "decision-provenance", question: "Who approved the Atlas warehouse decision?", relevantPaths: ["wiki/decisions/atlas-vendor.md"] },
    { id: "decision-pricing-choice", job: "decision-provenance", question: "Why did the pricing council choose usage-based automation pricing?", relevantPaths: ["wiki/decisions/pricing-model.md"] },
    { id: "decision-pricing-source", job: "decision-provenance", question: "What research supported the automation pricing decision?", relevantPaths: ["wiki/decisions/pricing-model.md"] },
    { id: "decision-launch-date", job: "decision-provenance", question: "Why did Apollo move the public launch to October?", relevantPaths: ["wiki/decisions/october-launch.md"] },
    { id: "decision-launch-owner", job: "decision-provenance", question: "Who made the final Apollo launch timing call?", relevantPaths: ["wiki/decisions/october-launch.md"] },

    { id: "meeting-eng-agenda", job: "meeting-prep", question: "What should I prepare for engineering staff about platform reliability?", relevantPaths: ["wiki/meetings/engineering-staff.md"] },
    { id: "meeting-eng-question", job: "meeting-prep", question: "What ownership question is open for the migration runbook meeting?", relevantPaths: ["wiki/meetings/engineering-staff.md"] },
    { id: "meeting-roadmap-agenda", job: "meeting-prep", question: "What projects are on the roadmap review agenda?", relevantPaths: ["wiki/meetings/roadmap-review.md"] },
    { id: "meeting-roadmap-bring", job: "meeting-prep", question: "What dependency list should I bring to the roadmap review?", relevantPaths: ["wiki/meetings/roadmap-review.md"] },
    { id: "meeting-customer-topics", job: "meeting-prep", question: "What customer risks are in the council preparation?", relevantPaths: ["wiki/meetings/customer-council.md"] },
    { id: "meeting-customer-presenter", job: "meeting-prep", question: "Who presents usage pricing research at customer council?", relevantPaths: ["wiki/meetings/customer-council.md"] },

    { id: "project-apollo-state", job: "project-state", question: "What is the current Apollo project state?", relevantPaths: ["wiki/projects/apollo.md"] },
    { id: "project-apollo-blockers", job: "project-state", question: "What still blocks the Apollo October launch?", relevantPaths: ["wiki/projects/apollo.md"] },
    { id: "project-beacon-state", job: "project-state", question: "How many teams are in the Beacon private beta?", relevantPaths: ["wiki/projects/beacon.md"] },
    { id: "project-beacon-milestone", job: "project-state", question: "What is Beacon's next milestone after capacity testing?", relevantPaths: ["wiki/projects/beacon.md"] },
    { id: "project-cedar-state", job: "project-state", question: "What is the current state of Cedar onboarding?", relevantPaths: ["wiki/projects/cedar.md"] },
    { id: "project-cedar-owner", job: "project-state", question: "Who leads Cedar onboarding design implementation?", relevantPaths: ["wiki/projects/cedar.md"] },

    { id: "synthesis-northstar-capacity", job: "cross-page-synthesis", question: "Synthesize Northstar capacity growth and regional failover work.", relevantPaths: ["wiki/syntheses/northstar-product.md", "wiki/syntheses/northstar-infrastructure.md"] },
    { id: "synthesis-northstar-risk", job: "cross-page-synthesis", question: "What do product and infrastructure say about Northstar regional failover capacity?", relevantPaths: ["wiki/syntheses/northstar-product.md", "wiki/syntheses/northstar-infrastructure.md"] },
    { id: "synthesis-hiring", job: "cross-page-synthesis", question: "Synthesize the reliability engineering hiring plan and budget.", relevantPaths: ["wiki/syntheses/hiring-plan.md", "wiki/syntheses/budget-plan.md"] },
    { id: "synthesis-hiring-quarter", job: "cross-page-synthesis", question: "How do hiring and budget plans support third quarter reliability roles?", relevantPaths: ["wiki/syntheses/hiring-plan.md", "wiki/syntheses/budget-plan.md"] },
    { id: "synthesis-incident-actions", job: "cross-page-synthesis", question: "Connect the database incident to reliability rollback rehearsal work.", relevantPaths: ["wiki/syntheses/incident-review.md", "wiki/syntheses/reliability-roadmap.md"] },
    { id: "synthesis-migration-reliability", job: "cross-page-synthesis", question: "What migration reliability actions follow from the database incident?", relevantPaths: ["wiki/syntheses/incident-review.md", "wiki/syntheses/reliability-roadmap.md"] },
  ]),
} satisfies RecallCorpus);
