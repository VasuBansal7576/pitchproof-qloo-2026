export function campaign(evidenceIds: string[], index = 0) {
  const devices = ['participation', 'story', 'product_discovery'] as const;
  return {
    device: devices[index],
    proposition: ['Make a city run part of the everyday routine', 'Give an ordinary departure a small personal meaning', 'Meet the supplied running shoe through its place in a city routine'][index],
    audienceTension: 'City runners may struggle to make time for their own routine',
    mechanism: ['Invite viewers to draw their own short route on a calendar', 'A runner chooses a personal outing over another ordinary evening indoors', 'A packed bag opens to reveal the supplied running shoe as the final object'][index],
    execution: 'Open on an unmarked calendar. Show the runner drawing a route, putting on the shoe and leaving. End on the product and an invitation to explore the campaign.',
    evidenceBridge: evidenceIds.map(evidenceId => ({ evidenceId, interpretation: 'This association suggests an everyday ritual as a creative hypothesis', relevance: 'An everyday ritual gives this footwear introduction a concrete occasion', uncertainty: 'The association does not establish customer preference or purchase intent' })),
  };
}

export function modelPilotProposal() {
  return {
    message: 'An everyday city routine has a personal rhythm.',
  };
}

export function testPlan() {
  return {
    kind: 'concept' as const,
    hypothesis: 'An everyday ritual proposition may produce more campaign interest than a neutral introduction',
    variable: 'The campaign proposition',
    variants: ['A 15-second everyday ritual message using an original calendar sequence', 'A neutral product message using the same original calendar sequence and verified product facts'],
    controls: 'Use the same format, length, channel, production standard, soundtrack, CTA, audience and landing page with randomized 50/50 allocation and equal spend',
    budget: 'Proposed capped spend of £200 over seven days, subject to agency approval',
    minimumData: 'Proposed minimum of 200 impressions per arm. Confirm feasibility and calculate power using the agency baseline and decision threshold',
    metric: 'Campaign-page clicks divided by delivered impressions',
    successCriterion: 'Predeclare a practical difference with the agency before delivery, then use the pilot to choose a concept for further testing',
    inconclusive: 'If delivery, minimum observations or decision evidence are insufficient at the cap, record the pilot as inconclusive and do not declare a winning concept',
  };
}

export function geminiResponse(body: Record<string, unknown>, value: unknown): Response {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return body.model
    ? Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] })
    : Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
}

export function isCampaignReview(body: Record<string, unknown>): boolean {
  const legacy = body.systemInstruction as { parts?: { text?: string }[] } | undefined;
  return String(body.system_instruction ?? legacy?.parts?.[0]?.text ?? '').includes('Review THREE campaign proposals');
}
