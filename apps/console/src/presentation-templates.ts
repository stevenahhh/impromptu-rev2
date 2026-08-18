export type PresentationTemplate = Readonly<{
  id: string;
  name: Readonly<{ en: string; ko: string }>;
  description: Readonly<{ en: string; ko: string }>;
  structure: "BRIEFING" | "KEYNOTE" | "WORKSHOP";
}>;

export const DEFAULT_PRESENTATION_TEMPLATES = [
  {
    id: "briefing",
    name: { en: "Briefing", ko: "브리핑" },
    description: {
      en: "A concise status, evidence, and decision flow.",
      ko: "현황, 근거, 결정을 간결하게 전달합니다.",
    },
    structure: "BRIEFING",
  },
  {
    id: "keynote",
    name: { en: "Keynote", ko: "키노트" },
    description: {
      en: "A narrative flow for a large audience.",
      ko: "큰 청중을 위한 이야기 중심 구성입니다.",
    },
    structure: "KEYNOTE",
  },
  {
    id: "workshop",
    name: { en: "Workshop", ko: "워크숍" },
    description: {
      en: "A sectioned flow for discussion and exercises.",
      ko: "토론과 실습을 위한 구획형 구성입니다.",
    },
    structure: "WORKSHOP",
  },
] as const satisfies readonly PresentationTemplate[];
