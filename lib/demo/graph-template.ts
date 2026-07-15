import type {
  ClaimGraph,
  GraphEdge,
  GraphNode,
  Snippet,
  Source
} from "@/types/claimgraph";

export const DEFAULT_DEMO_QUESTION = "Should cities ban cars downtown?";

function isMobilityQuestion(question: string) {
  return /(car|cars|downtown|traffic|pedestrian|pedestrianized|street|streets|city)/i.test(
    question
  );
}

function buildMobilitySources(): Source[] {
  return [
    {
      id: "src_air_report",
      type: "web",
      title: "Downtown Air Quality Pilot Report",
      domain: "demo.local",
      sourceKind: "government",
      isPrimary: true
    },
    {
      id: "src_walkability_study",
      type: "web",
      title: "Pedestrian Zone Outcomes Study",
      domain: "demo.local",
      sourceKind: "research",
      isPrimary: true
    },
    {
      id: "src_merchant_survey",
      type: "file",
      title: "Merchant Survey",
      fileName: "merchant-survey.pdf",
      sourceKind: "memo",
      isPrimary: true
    },
    {
      id: "src_transit_audit",
      type: "file",
      title: "Transit Capacity Audit",
      fileName: "transit-capacity-audit.pdf",
      sourceKind: "research",
      isPrimary: true
    },
    {
      id: "src_spillover_note",
      type: "web",
      title: "Neighborhood Spillover Traffic Note",
      domain: "demo.local",
      sourceKind: "ngo"
    }
  ];
}

function buildMobilitySnippets(): Snippet[] {
  return [
    {
      id: "sn_air_drop",
      sourceId: "src_air_report",
      text: "Pilot measurements showed lower roadside pollution inside the restricted downtown zone during peak hours.",
      rationale: "Supports the case that limiting cars can improve local air quality.",
      relevance: 0.94,
      origin: "starter_curated"
    },
    {
      id: "sn_footfall",
      sourceId: "src_walkability_study",
      text: "Cities that paired street restrictions with transit upgrades often reported more walking activity and longer dwell time in the core.",
      rationale: "Supports the claim that walkable districts can strengthen foot traffic.",
      relevance: 0.88,
      origin: "starter_curated"
    },
    {
      id: "sn_retail_loss",
      sourceId: "src_merchant_survey",
      text: "Businesses dependent on quick pickup visits reported lower convenience-driven sales after access changes.",
      rationale: "Supports the argument that some retailers lose drive-in customers.",
      relevance: 0.82,
      origin: "starter_curated"
    },
    {
      id: "sn_transit_dependency",
      sourceId: "src_transit_audit",
      text: "Benefits depended heavily on whether transit service, freight windows, and accessibility exemptions were strong enough.",
      rationale: "Shows that the overall outcome depends on local implementation quality.",
      relevance: 0.91,
      origin: "starter_curated"
    },
    {
      id: "sn_spillover",
      sourceId: "src_spillover_note",
      text: "Residents near boundary streets reported increased congestion where diverted traffic concentrated.",
      rationale: "Supports the concern that harms may shift rather than disappear.",
      relevance: 0.85,
      origin: "starter_curated"
    }
  ];
}

function buildMobilityGraph(question: string): ClaimGraph {
  const nodes: GraphNode[] = [
    {
      id: "q_root",
      kind: "question",
      title: question,
      summary:
        "The main policy question. The graph maps the strongest benefits, costs, and unresolved dependencies around downtown car restrictions.",
      sourceIds: [],
      snippetIds: []
    },
    {
      id: "claim_air",
      kind: "claim",
      title: "Car-free zones can improve local air quality",
      summary:
        "Supporters argue that restricting cars in the urban core reduces roadside emissions where people walk and gather.",
      topic: "environment",
      stance: "pro",
      confidence: 0.86,
      sourceIds: ["src_air_report"],
      snippetIds: ["sn_air_drop"]
    },
    {
      id: "claim_footfall",
      kind: "claim",
      title: "Walkable centers can increase foot traffic",
      summary:
        "Supporters argue that a calmer street environment can make downtown more attractive to people on foot.",
      topic: "business",
      stance: "pro",
      confidence: 0.79,
      sourceIds: ["src_walkability_study"],
      snippetIds: ["sn_footfall"]
    },
    {
      id: "counter_spill",
      kind: "counterclaim",
      title: "Traffic may shift to nearby streets",
      summary:
        "Opponents argue that the policy can relocate congestion and pollution to the district edge instead of removing it.",
      topic: "environment",
      stance: "con",
      confidence: 0.8,
      sourceIds: ["src_spillover_note"],
      snippetIds: ["sn_spillover"]
    },
    {
      id: "counter_retail",
      kind: "counterclaim",
      title: "Some retailers lose convenience-driven customers",
      summary:
        "Opponents argue that businesses relying on quick vehicle access can lose sales even if the district becomes more pleasant overall.",
      topic: "business",
      stance: "con",
      confidence: 0.78,
      sourceIds: ["src_merchant_survey"],
      snippetIds: ["sn_retail_loss"]
    },
    {
      id: "gap_transit",
      kind: "gap",
      title: "Outcome depends on transit, freight, and exemptions",
      summary:
        "The policy is hard to judge without knowing whether transit capacity, accessible access, and delivery windows are strong enough.",
      topic: "implementation",
      confidence: 0.9,
      sourceIds: ["src_transit_audit"],
      snippetIds: ["sn_transit_dependency"],
      metadata: {
        gapType: "assumption_dependency"
      }
    },
    {
      id: "e_air",
      kind: "evidence",
      title: "Peak-hour roadside pollution declined",
      summary: "Air quality measurements improved inside the pilot zone during peak periods.",
      sourceIds: ["src_air_report"],
      snippetIds: ["sn_air_drop"]
    },
    {
      id: "e_footfall",
      kind: "evidence",
      title: "Foot-traffic gains tracked transit upgrades",
      summary:
        "Case studies linked stronger foot traffic to paired transit improvements, not street closure alone.",
      sourceIds: ["src_walkability_study"],
      snippetIds: ["sn_footfall"]
    },
    {
      id: "e_spill",
      kind: "evidence",
      title: "Boundary streets absorbed diverted traffic",
      summary: "Spillover congestion was reported on nearby perimeter routes.",
      sourceIds: ["src_spillover_note"],
      snippetIds: ["sn_spillover"]
    },
    {
      id: "e_retail",
      kind: "evidence",
      title: "Pickup-oriented merchants reported losses",
      summary:
        "A merchant survey identified convenience-dependent businesses as the most exposed group.",
      sourceIds: ["src_merchant_survey"],
      snippetIds: ["sn_retail_loss"]
    }
  ];

  const edges: GraphEdge[] = [
    { id: "edge_claim_air_q", from: "claim_air", to: "q_root", relation: "supports", strength: 0.88 },
    { id: "edge_claim_foot_q", from: "claim_footfall", to: "q_root", relation: "supports", strength: 0.79 },
    { id: "edge_counter_spill_q", from: "counter_spill", to: "q_root", relation: "refutes", strength: 0.82 },
    { id: "edge_counter_retail_q", from: "counter_retail", to: "q_root", relation: "refutes", strength: 0.8 },
    { id: "edge_gap_q", from: "gap_transit", to: "q_root", relation: "depends_on", strength: 0.9 },
    { id: "edge_e_air_claim", from: "e_air", to: "claim_air", relation: "supports", strength: 0.94 },
    { id: "edge_e_foot_claim", from: "e_footfall", to: "claim_footfall", relation: "supports", strength: 0.88 },
    { id: "edge_e_spill_counter", from: "e_spill", to: "counter_spill", relation: "supports", strength: 0.85 },
    { id: "edge_e_retail_counter", from: "e_retail", to: "counter_retail", relation: "supports", strength: 0.82 },
    { id: "edge_spill_refutes_air", from: "counter_spill", to: "claim_air", relation: "refutes", strength: 0.76 },
    { id: "edge_retail_refutes_foot", from: "counter_retail", to: "claim_footfall", relation: "refutes", strength: 0.84 },
    { id: "edge_gap_claim_air", from: "gap_transit", to: "claim_air", relation: "qualifies", strength: 0.7 },
    { id: "edge_gap_claim_foot", from: "gap_transit", to: "claim_footfall", relation: "depends_on", strength: 0.9 }
  ];

  return {
    question,
    nodes,
    edges,
    disagreementClusters: [
      {
        id: "dc_business",
        claimIds: ["claim_footfall", "counter_retail"],
        score: 0.84,
        title: "Do downtown businesses gain or lose?",
        explanation:
          "This is the sharpest conflict because both sides have meaningful support and the answer is central to whether the policy feels successful in practice.",
        sourceIds: ["src_walkability_study", "src_merchant_survey", "src_transit_audit"],
        snippetIds: ["sn_footfall", "sn_retail_loss", "sn_transit_dependency"]
      },
      {
        id: "dc_environment",
        claimIds: ["claim_air", "counter_spill"],
        score: 0.78,
        title: "Do emissions fall overall or just move?",
        explanation:
          "Local air quality gains are plausible, but the key disagreement is whether they are partially offset by spillover on boundary streets.",
        sourceIds: ["src_air_report", "src_spillover_note"],
        snippetIds: ["sn_air_drop", "sn_spillover"]
      }
    ],
    primaryClusterId: "dc_business",
    graphSummary:
      "The strongest pro case is that downtown restrictions improve street conditions and foot traffic. The strongest con case is that some harms are displaced to merchants and nearby streets. The central unresolved dependency is whether transit, freight handling, and exemptions are strong enough."
  };
}

function normalizeQuestionText(question: string) {
  return question.replace(/\s+/g, " ").trim().replace(/[?!.]+$/g, "");
}

function buildStarterFrame(question: string) {
  const normalizedQuestion = normalizeQuestionText(question) || "this question";
  const proposalText = normalizedQuestion
    .replace(/^should\s+/i, "")
    .trim() || normalizedQuestion;
  const quotedQuestion = `"${normalizedQuestion}?"`;
  const isBanQuestion = /\b(ban|banned|forbid|prohibit|outlaw)\b/i.test(proposalText);
  const isNationalQuestion = /\b(country|nation|national|nationwide|all\s+the\s+country)\b/i.test(
    proposalText
  );
  const scopeLabel = isNationalQuestion ? "national" : "context-specific";

  if (isBanQuestion) {
    return {
      normalizedQuestion,
      quotedQuestion,
      proposalText,
      supportTitle: isNationalQuestion
        ? "Supporters need evidence for a national ban"
        : "Supporters need evidence for the ban",
      counterTitle: isNationalQuestion
        ? "Critics need evidence on rights and enforcement harms"
        : "Critics need evidence on harms and enforcement costs",
      gapTitle: isNationalQuestion
        ? "Needs country-specific law and definition sources"
        : "Needs direct sources on scope, definition, and enforcement",
      supportEvidenceTitle: "Sample source path for the pro-ban case",
      counterEvidenceTitle: "Sample source path for the anti-ban case",
      clusterTitle: isNationalQuestion
        ? "Would a national ban solve more than it harms?"
        : "Would the ban solve more than it harms?",
      topicSupport: "public interest",
      topicCounter: "rights and enforcement",
      topicGap: "legal scope",
      supportText: `Starter scaffold for ${quotedQuestion}: supporters would need direct sources showing the ban solves a defined public-interest problem without relying on slogans.`,
      supportRationale:
        "Marks the pro side as a source requirement, not as an evidence-backed conclusion.",
      counterText: `Starter scaffold for ${quotedQuestion}: critics would need direct sources about civil rights, enforcement risk, minority impact, or overbroad definitions.`,
      counterRationale:
        "Marks the counterclaim side as a source requirement, not as an evidence-backed conclusion.",
      dependencyText: `Starter scaffold for ${quotedQuestion}: the map cannot be trusted until it has ${scopeLabel} legal definitions, enforcement details, and empirical evidence from specific sources.`,
      dependencyRationale:
        "Keeps the missing source requirement visible before anyone treats the starter map as settled.",
      graphSummary: `This is a sample starter scaffold for ${quotedQuestion}. It does not answer the question yet; it shows the claim, counterclaim, and gap structure that real sources must fill before the map can be trusted.`
    };
  }

  return {
    normalizedQuestion,
    quotedQuestion,
    proposalText,
    supportTitle: "Supporters need evidence that the proposal works",
    counterTitle: "Critics need evidence of tradeoffs or harm",
    gapTitle: "Needs sources specific to this question",
    supportEvidenceTitle: "Sample source path for the supporting case",
    counterEvidenceTitle: "Sample source path for the critical case",
    clusterTitle: "Do the benefits outweigh the unresolved costs?",
    topicSupport: "benefits",
    topicCounter: "costs",
    topicGap: "missing context",
    supportText: `Starter scaffold for ${quotedQuestion}: supporters would need direct sources showing the proposal creates a measurable benefit in the relevant setting.`,
    supportRationale:
      "Marks the pro side as a source requirement, not as an evidence-backed conclusion.",
    counterText: `Starter scaffold for ${quotedQuestion}: critics would need direct sources showing who bears costs, what harms appear, and whether the harms are avoidable.`,
    counterRationale:
      "Marks the counterclaim side as a source requirement, not as an evidence-backed conclusion.",
    dependencyText: `Starter scaffold for ${quotedQuestion}: the map cannot be trusted until it has source-backed definitions, local constraints, and implementation details.`,
    dependencyRationale:
      "Keeps the missing source requirement visible before anyone treats the starter map as settled.",
    graphSummary: `This is a sample starter scaffold for ${quotedQuestion}. It does not answer the question yet; it shows the claim, counterclaim, and gap structure that real sources must fill before the map can be trusted.`
  };
}

function buildGenericSources(): Source[] {
  return [
    {
      id: "src_research_brief",
      type: "web",
      title: "Sample Support Source Note",
      domain: "demo.local",
      sourceKind: "research",
      isPrimary: true
    },
    {
      id: "src_stakeholder_memo",
      type: "file",
      title: "Sample Critique Source Note",
      fileName: "sample-critique-source-note.pdf",
      sourceKind: "memo",
      isPrimary: true
    },
    {
      id: "src_operations_note",
      type: "web",
      title: "Sample Context Source Note",
      domain: "demo.local",
      sourceKind: "company"
    }
  ];
}

function buildGenericSnippets(question: string): Snippet[] {
  const frame = buildStarterFrame(question);

  return [
    {
      id: "sn_demo_upside",
      sourceId: "src_research_brief",
      text: frame.supportText,
      rationale: frame.supportRationale,
      relevance: 0.9,
      origin: "starter_curated"
    },
    {
      id: "sn_demo_costs",
      sourceId: "src_stakeholder_memo",
      text: frame.counterText,
      rationale: frame.counterRationale,
      relevance: 0.86,
      origin: "starter_curated"
    },
    {
      id: "sn_demo_dependency",
      sourceId: "src_operations_note",
      text: frame.dependencyText,
      rationale: frame.dependencyRationale,
      relevance: 0.92,
      origin: "starter_curated"
    }
  ];
}

function buildGenericGraph(question: string): ClaimGraph {
  const frame = buildStarterFrame(question);
  const nodes: GraphNode[] = [
    {
      id: "q_root",
      kind: "question",
      title: question,
      summary:
        "This starter graph is sample scaffolding. It preserves the map shape, but it is not a source-backed answer until you add sources and rebuild.",
      sourceIds: [],
      snippetIds: []
    },
    {
      id: "claim_upside",
      kind: "claim",
      title: frame.supportTitle,
      summary:
        `For ${frame.quotedQuestion}, this starter claim marks the pro side that needs direct sources before it should be treated as grounded.`,
      topic: frame.topicSupport,
      stance: "pro",
      confidence: 0.78,
      sourceIds: ["src_research_brief"],
      snippetIds: ["sn_demo_upside"]
    },
    {
      id: "counter_costs",
      kind: "counterclaim",
      title: frame.counterTitle,
      summary:
        `For ${frame.quotedQuestion}, this starter counterclaim marks the critical side that needs direct sources before it should be treated as grounded.`,
      topic: frame.topicCounter,
      stance: "con",
      confidence: 0.8,
      sourceIds: ["src_stakeholder_memo"],
      snippetIds: ["sn_demo_costs"]
    },
    {
      id: "gap_context",
      kind: "gap",
      title: frame.gapTitle,
      summary:
        `ClaimGraph needs direct sources for ${frame.quotedQuestion} before this map can say which side is stronger.`,
      topic: frame.topicGap,
      confidence: 0.88,
      sourceIds: ["src_operations_note"],
      snippetIds: ["sn_demo_dependency"]
    },
    {
      id: "e_upside",
      kind: "evidence",
      title: frame.supportEvidenceTitle,
      summary: "This is a sample evidence path, not a fetched external citation.",
      sourceIds: ["src_research_brief"],
      snippetIds: ["sn_demo_upside"]
    },
    {
      id: "e_costs",
      kind: "evidence",
      title: frame.counterEvidenceTitle,
      summary: "This is a sample evidence path, not a fetched external citation.",
      sourceIds: ["src_stakeholder_memo"],
      snippetIds: ["sn_demo_costs"]
    }
  ];

  const edges: GraphEdge[] = [
    { id: "edge_upside_q", from: "claim_upside", to: "q_root", relation: "supports", strength: 0.78 },
    { id: "edge_costs_q", from: "counter_costs", to: "q_root", relation: "refutes", strength: 0.8 },
    { id: "edge_gap_q", from: "gap_context", to: "q_root", relation: "depends_on", strength: 0.88 },
    { id: "edge_e_upside_claim", from: "e_upside", to: "claim_upside", relation: "supports", strength: 0.9 },
    { id: "edge_e_costs_counter", from: "e_costs", to: "counter_costs", relation: "supports", strength: 0.86 },
    { id: "edge_counter_refutes_claim", from: "counter_costs", to: "claim_upside", relation: "refutes", strength: 0.81 },
    { id: "edge_gap_qualifies_claim", from: "gap_context", to: "claim_upside", relation: "qualifies", strength: 0.72 }
  ];

  return {
    question,
    nodes,
    edges,
    disagreementClusters: [
      {
        id: "dc_generic",
        claimIds: ["claim_upside", "counter_costs"],
        score: 0.82,
        title: frame.clusterTitle,
        explanation:
          `This starter disagreement is a sample structure for ${frame.quotedQuestion}. It shows what real sources must prove on each side before the graph is trustworthy.`,
        sourceIds: ["src_research_brief", "src_stakeholder_memo", "src_operations_note"],
        snippetIds: ["sn_demo_upside", "sn_demo_costs", "sn_demo_dependency"]
      }
    ],
    primaryClusterId: "dc_generic",
    graphSummary: frame.graphSummary
  };
}

export function buildStarterDataset(question: string) {
  if (isMobilityQuestion(question)) {
    return {
      sources: buildMobilitySources(),
      snippets: buildMobilitySnippets(),
      graph: buildMobilityGraph(question)
    };
  }

  return {
    sources: buildGenericSources(),
    snippets: buildGenericSnippets(question),
    graph: buildGenericGraph(question)
  };
}
