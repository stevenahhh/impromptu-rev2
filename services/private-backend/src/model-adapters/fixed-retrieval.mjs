const evidenceId = "internal:runtime-fixture:r1";

export function embedding() {
  return { vector: [0.1, 0.2, 0.3] };
}

export function rerank() {
  return { orderedEvidenceIds: [evidenceId] };
}

export function llm() {
  return {
    claim: "Acme revenue was 42 million USD in 2025.",
    evidenceIds: [evidenceId],
    facts: {
      numbers: ["42", "2025"],
      units: ["million", "USD"],
      dates: [],
      entities: ["Acme"],
    },
  };
}

export function verifier() {
  return { verdict: "SUPPORTED", rationaleCode: "fixed-runtime-evidence" };
}
