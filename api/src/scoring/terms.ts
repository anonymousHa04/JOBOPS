// Term normalization for deterministic matching of JD wording against the bank.

export const SYNONYMS: Record<string, string> = {
  k8s: "kubernetes",
  js: "javascript",
  ts: "typescript",
  golang: "go",
  postgres: "postgresql",
  node: "node.js",
  nodejs: "node.js",
  "aws lambda": "lambda",
  gcp: "google cloud",
  llms: "llm",
  "large language models": "llm",
  "ci/cd": "ci-cd",
  "rest api": "rest",
  "rest apis": "rest",
  restful: "rest",
  ml: "machine learning",
  genai: "generative ai",
  "agentic ai": "agents",
  "ai agents": "agents",
  eks: "kubernetes",
  gke: "kubernetes",
  aks: "kubernetes",
  "amazon web services": "aws",
  reactjs: "react",
  "react.js": "react",
  "next.js": "nextjs",
  "vue.js": "vue",
  "node js": "node.js",
  "machine-learning": "machine learning"
};

export function norm(s: string): string {
  const t = s.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,;:!?]+$/, "");
  return SYNONYMS[t] ?? t;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Normalizes synonyms inside a longer phrase, whole words only.
function normText(s: string): string {
  let t = norm(s);
  for (const [from, to] of Object.entries(SYNONYMS)) {
    t = t.replace(new RegExp(`(^|[^a-z0-9])${escape(from)}(?=$|[^a-z0-9])`, "g"), `$1${to}`);
  }
  return t;
}

export function hasTerm(text: string, term: string): boolean {
  const t = norm(term);
  return t !== "" && new RegExp(`(^|[^a-z0-9])${escape(t)}($|[^a-z0-9])`).test(normText(text));
}

// Every vocabulary term that appears in s as a whole word or phrase.
export function terms(s: string, vocab: Set<string>): string[] {
  const found = new Set<string>();
  for (const v of vocab) {
    if (hasTerm(s, v)) found.add(norm(v));
  }
  return [...found];
}
