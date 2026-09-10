const STORAGE_SERVER_URL = "http://127.0.0.1:8787/api/state";
const STORAGE_REQUEST_TIMEOUT_MS = 1200;
const STORAGE_RETRY_DELAY_MS = 15000;
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TASK_ID_ALIASES = {
  "project-thesis-abstract": ["project-report-abstract"],
  "project-thesis-introduction": [
    "project-report-outline",
    "project-report-introduction",
  ],
  "project-thesis-theory": ["project-report-theory", "project-report-background"],
  "project-thesis-numerical-method": [
    "project-report-method",
    "project-report-methodology",
  ],
  "project-thesis-results": ["project-report-results", "project-report-draft"],
  "project-thesis-discussion": [
    "project-report-discussion",
    "project-report-analysis",
  ],
  "project-thesis-conclusion": ["project-report-conclusion", "project-report-submit"],
  "condensed-topic-11": ["condensed-problem-week-11"],
  "condensed-topic-12": ["condensed-problem-week-12"],
  "condensed-topic-13": ["condensed-problem-week-13"],
};

const storageUiState = {
  mode: "loading",
  recoveredLegacyTasks: 0,
};

let serverSyncAvailable = false;
let serverSyncRetryAfter = 0;
let pendingServerSnapshot = null;
let serverSaveTimerId = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function createEmptyState() {
  return {
    tasks: {},
    notes: {},
    dailyLog: {},
    deadlines: {},
    timeline: {
      energyByDate: {},
      effectiveDates: {},
      skipped: {},
      moveCounts: {},
      reopenedModules: {},
    },
    updatedAt: 0,
  };
}

function normalizeTaskMap(taskMap) {
  const normalized = {};

  if (!taskMap || typeof taskMap !== "object") {
    return normalized;
  }

  Object.entries(taskMap).forEach(([taskId, value]) => {
    if (value) {
      normalized[taskId] = true;
    }
  });

  return normalized;
}

function normalizeNotesMap(notes) {
  const normalized = {};

  if (!notes || typeof notes !== "object") {
    return normalized;
  }

  Object.entries(notes).forEach(([courseId, note]) => {
    if (typeof note === "string") {
      normalized[courseId] = note;
    }
  });

  return normalized;
}

function normalizeDeadlineMap(deadlines) {
  const normalized = {};

  if (!deadlines || typeof deadlines !== "object") {
    return normalized;
  }

  Object.entries(deadlines).forEach(([deadlineId, value]) => {
    if (value) {
      normalized[deadlineId] = true;
    }
  });

  return normalized;
}

function normalizeStringMap(values) {
  const normalized = {};

  if (!values || typeof values !== "object") {
    return normalized;
  }

  Object.entries(values).forEach(([key, value]) => {
    if (typeof value === "string" && value) {
      normalized[key] = value;
    }
  });

  return normalized;
}

function normalizeBooleanMap(values) {
  const normalized = {};

  if (!values || typeof values !== "object") {
    return normalized;
  }

  Object.entries(values).forEach(([key, value]) => {
    if (value) {
      normalized[key] = true;
    }
  });

  return normalized;
}

function normalizeNumberMap(values) {
  const normalized = {};

  if (!values || typeof values !== "object") {
    return normalized;
  }

  Object.entries(values).forEach(([key, value]) => {
    const numberValue = Number(value);

    if (Number.isFinite(numberValue) && numberValue > 0) {
      normalized[key] = numberValue;
    }
  });

  return normalized;
}

function normalizeTimelineState(timeline) {
  return {
    energyByDate: normalizeStringMap(timeline?.energyByDate),
    effectiveDates: normalizeStringMap(timeline?.effectiveDates),
    skipped: normalizeBooleanMap(timeline?.skipped),
    moveCounts: normalizeNumberMap(timeline?.moveCounts),
    reopenedModules: normalizeBooleanMap(timeline?.reopenedModules),
  };
}

function normalizeCompletedTasks(completedTasks) {
  if (!Array.isArray(completedTasks)) {
    return [];
  }

  return completedTasks
    .map((completion) => ({
      taskId:
        typeof completion?.taskId === "string" ? completion.taskId : "",
      label: typeof completion?.label === "string" ? completion.label : "",
      timestamp: Number(completion?.timestamp) || 0,
      timeLabel:
        typeof completion?.timeLabel === "string" ? completion.timeLabel : "",
    }))
    .filter((completion) => completion.taskId || completion.label);
}

function normalizeDailyEntryData(entry) {
  return {
    done: typeof entry?.done === "string" ? entry.done : "",
    reminder: typeof entry?.reminder === "string" ? entry.reminder : "",
    completedTasks: normalizeCompletedTasks(entry?.completedTasks),
  };
}

function normalizeDailyLog(dailyLog) {
  const normalized = {};

  if (!dailyLog || typeof dailyLog !== "object") {
    return normalized;
  }

  Object.entries(dailyLog).forEach(([dateKey, entry]) => {
    const normalizedEntry = normalizeDailyEntryData(entry);

    if (hasDailyEntry(normalizedEntry)) {
      normalized[dateKey] = normalizedEntry;
    }
  });

  return normalized;
}

function normalizeState(candidate) {
  return {
    tasks: normalizeTaskMap(candidate?.tasks),
    notes: normalizeNotesMap(candidate?.notes),
    dailyLog: normalizeDailyLog(candidate?.dailyLog),
    deadlines: normalizeDeadlineMap(candidate?.deadlines),
    timeline: normalizeTimelineState(candidate?.timeline),
    updatedAt: Number(candidate?.updatedAt) || 0,
  };
}

function createWeekTasks(prefix, totalWeeks, label) {
  return Array.from({ length: totalWeeks }, (_, index) => ({
    id: `${prefix}-week-${index + 1}`,
    title: `Week ${index + 1}`,
    caption: label ? `${label} for week ${index + 1}` : "",
  }));
}

function createWeekRangeTasks(prefix, startWeek, count, label) {
  return Array.from({ length: count }, (_, index) => {
    const weekNumber = startWeek + index;

    return {
      id: `${prefix}-week-${weekNumber}`,
      title: `Week ${weekNumber}`,
      caption: label ? `${label} for week ${weekNumber}` : "",
    };
  });
}

function createPastPapers(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-paper-${index + 1}`,
    title: `Past Paper ${index + 1}`,
    caption: "Use this as a proper timed or revision paper.",
  }));
}

function createNamedPastPapers(prefix, titles) {
  return titles.map((title, index) => ({
    id: `${prefix}-paper-${index + 1}`,
    title,
    caption: "Track this specific paper by name.",
  }));
}

function createPaperPartTasks(entries, labels = { a: "Part A", b: "Part B" }) {
  return entries.flatMap((entry) => [
    {
      id: `${entry.id}-part-a`,
      title: `${entry.title} - ${labels.a}`,
      caption: entry.partAFocus || entry.sectionAFocus || "",
    },
    {
      id: `${entry.id}-part-b`,
      title: `${entry.title} - ${labels.b}`,
      caption: entry.partBFocus || entry.sectionBFocus || "",
    },
  ]);
}

function getQuantumPastPaperParentId(index) {
  return `qm2-paper-${index + 1}`;
}

function getQuantumPastPaperPartIds(parentTaskId) {
  if (!/^qm2-paper-\d+$/.test(parentTaskId)) {
    return [];
  }

  return [`${parentTaskId}-part-a`, `${parentTaskId}-part-b`];
}

function getQuantumPastPaperParentTaskId(taskId) {
  const match = taskId.match(/^(qm2-paper-\d+)-part-(a|b)$/);
  return match ? match[1] : "";
}

function createQuantumPastPaperTasks() {
  return QM2_PAST_PAPER_TITLES.flatMap((title, index) => {
    const parentTaskId = getQuantumPastPaperParentId(index);

    return [
      {
        id: parentTaskId,
        title,
        caption: "Full paper. This checks itself when Part A and Part B are both done.",
        excludeFromProgress: true,
        isTaskGroupParent: true,
      },
      {
        id: `${parentTaskId}-part-a`,
        title: `${title} - Part A`,
        caption: "Section A only.",
        parentTaskId,
      },
      {
        id: `${parentTaskId}-part-b`,
        title: `${title} - Part B`,
        caption: "Section B only.",
        parentTaskId,
      },
    ];
  });
}

function createBiweeklySets(prefix) {
  return Array.from({ length: 5 }, (_, index) => {
    const startWeek = index * 2 + 1;
    const endWeek = startWeek + 1;

    return {
      id: `${prefix}-set-${index + 1}`,
      title: `Problem Set ${index + 1}`,
      caption: `Covers weeks ${startWeek} to ${endWeek}.`,
    };
  });
}

const QM2_PAST_PAPER_TITLES = [
  "2021/22 May",
  "2021/22 August",
  "2022/23 May",
  "2022/23 August",
  "2023/24 May",
  "2023/24 August",
  "2024/25 May",
  "2024/25 August",
  "Mock Exam Paper",
];

const NANO_PAST_PAPER_ENTRIES = [
  {
    id: "nano-paper-may-2024",
    title: "May 2024",
    file: "6CCP9300 Fundamentals_of_Nanotechnology_May_Solutions_2024.pdf",
    partAFocus:
      "LSP/Frohlich, SEM vs AFM, photothermal therapy, exciton Bohr radius, CdSe QDs, oxidation/shells",
    partBFocus: "B2 plasmonics, B3 PN junctions/solar cells/graphene/CNTs",
  },
  {
    id: "nano-paper-august-2024",
    title: "August 2024",
    file: "6CCP9300 Fundamentals_of_Nanotechnology_August 2024_with Solutions.pdf",
    partAFocus:
      "TIR penetration depth, plasmonic solar-cell enhancement, LSP vs SPP sensing, exciton Bohr radius, QD colour/size, shells, magnetism",
    partBFocus: "B2 SPPs, B3 solar cells/CNTs",
  },
  {
    id: "nano-paper-solutions-final",
    title: "Solutions final",
    file: "6CCP9300_Fundamentals_of_Nanotechnology_Solutions_final_.pdf",
    partAFocus: "Part A only.",
    partBFocus: "Part B only.",
  },
  {
    id: "nano-paper-2020-21-may",
    title: "2020/21 May",
    file: "6CCP9930_Fundamentals_of_Nanotechnology_2020-2021_May_final Solutions.pdf",
    partAFocus:
      "AFM/SEM, Lycurgus cup, plasmonics applications, LSP calculations, SPP sensing, QDs, oxidation, MRI, magnetism",
    partBFocus: "B2 nanoscale light/SPP, B3 PN junction/solar cells, B4 SPP/CNTs",
  },
  {
    id: "nano-paper-final-august-2024",
    title: "Final August 2024",
    file: "Fundamentals of Nanotechnology final August2024.pdf",
    partAFocus: "Part A only.",
    partBFocus: "Part B only.",
  },
  {
    id: "nano-paper-revision-week-closed-book",
    title: "Revision-week closed-book questions",
    file: "PART 1 of 6CCP9300 revision week question closed bookAmelle Zair.pdf",
    partAFocus:
      "AlN exciton Bohr radius, quantum confinement, MRI, Fe3O4 vs Fe2O3/capping agent",
    partBFocus:
      "PN junction, Gratzel solar cell, graphene mono/bilayer, CNT configurations/DNA sequencing",
  },
];

const CONDENSED_ORDER_PAPER_ENTRIES = [
  {
    id: "condensed-2025-v3-paper",
    title: "2025 / v3 Main Paper",
    file: "6CCP2000_v3.pdf",
    whyNow:
      "This overrides the old-paper-first plan. Section A is the safety net; 40 marks from Section A plus about half of one Section B can be pass territory.",
    sectionAFocus:
      "Do the full Section A safety net: 2D DOS, reciprocal lattice, phonons, structure factor, optics, hysteresis, band filling.",
    sectionBFocus:
      "Answer all 3 Section B questions. Follow scaffolded sub-parts and never skip later parts because error propagation is forgiving.",
  },
];

const CONDENSED_SIMILARITY_PAPER_ENTRIES = [
  {
    id: "condensed-paper-aug-2014-resit",
    title: "Aug 2014 (resit)",
    whyNow:
      "Extra practice only now. Keep B2 Drude and B4 semiconductor if time remains.",
    skipNotes: "Demoted from main-first paper by the 3-day 2025/v3 plan.",
  },
  {
    id: "condensed-paper-aug-2015",
    title: "Aug 2015",
    whyNow:
      "Similarity practice for Heisenberg two-spin and mass-defect phonon.",
    skipNotes: "Use only after the 2025/v3 safety-net and archetype tasks.",
  },
  {
    id: "condensed-paper-aug-2013-resit",
    title: "Aug 2013 (resit)",
    whyNow:
      "Similarity practice for reciprocal-lattice proof, NFE bands, and Drude/Poisson timing.",
    skipNotes: "Do not let this replace the 2025/v3 order.",
  },
  {
    id: "condensed-paper-summer-2015",
    title: "Summer 2015",
    whyNow: "Similarity practice for C60 crystallography and powder diffraction.",
  },
  {
    id: "condensed-paper-summer-2014-draft",
    title: "Summer 2014 (draft)",
    whyNow: "Similarity practice for Madelung and CsH structure factor.",
    skipNotes: "Skip off-syllabus/red-trap parts.",
  },
  {
    id: "condensed-paper-aug-2012-resit",
    title: "Aug 2012 (resit)",
    whyNow:
      "Similarity practice for Miller indices, free-vs-NFE, and semiclassical Bloch EOM.",
  },
  {
    id: "condensed-paper-summer-2013",
    title: "Summer 2013",
    whyNow: "Similarity practice for Fe Tc -> J and DOS sketches.",
    skipNotes: "Mostly Section A value.",
  },
  {
    id: "condensed-paper-summer-2012",
    title: "Summer 2012",
    whyNow: "Similarity practice for solar cell I-V / fill factor and long Section A warm-up.",
  },
  {
    id: "condensed-paper-summer-2016",
    title: "Summer 2016",
    whyNow: "Selective similarity practice only.",
    skipNotes: "Only use if the 2025/v3 checklist is already safe.",
  },
];

function createQuantumRevisionTasks() {
  return [
    {
      id: "qm2-wkb-foundations",
      title: "WKB foundations",
      caption: "Review the approximation, assumptions, and where it breaks down.",
    },
    {
      id: "qm2-wkb-turning-points",
      title: "WKB turning points",
      caption: "Work through matching conditions, connection formulas, and tunnelling setup.",
    },
    {
      id: "qm2-wkb-exam-practice",
      title: "WKB exam-style practice",
      caption: "Do focused WKB questions before or alongside the past papers.",
    },
    ...createQuantumPastPaperTasks(),
  ];
}

function createMasterPlanTasks(blockId, taskItems) {
  return taskItems.map((taskItem, index) => {
    if (typeof taskItem === "string") {
      return {
        id: `study-plan-${blockId}-task-${index + 1}`,
        title: taskItem,
      };
    }

    return {
      id: `study-plan-${blockId}-task-${index + 1}`,
      title: taskItem.title,
      caption: taskItem.caption || "",
    };
  });
}

function createMasterPlanBlock({
  id,
  order,
  moduleId,
  title,
  priority,
  type,
  reason = "",
  tasks = [],
  sourceFile = "",
  question = "",
  task = "",
  skill = "",
}) {
  const module = MASTER_PLAN_MODULES[moduleId];
  const taskItems = tasks.length
    ? tasks
    : [
        {
          title: task,
          caption: sourceFile && question ? `${sourceFile} • ${question}` : "",
        },
        {
          title: "Record mistakes and method notes",
          caption:
            "Log what went wrong, the method that worked, and anything worth repeating later.",
        },
      ];

  return {
    id,
    order,
    moduleId,
    moduleLabel: module.label,
    shortModule: module.shortLabel,
    accent: module.accent,
    deadline: module.deadline,
    deadlineLabel: module.deadlineLabel,
    title,
    priority,
    type,
    reason,
    sourceFile,
    question,
    task,
    skill,
    tasks: createMasterPlanTasks(id, taskItems),
  };
}

const MASTER_PLAN_SECTION_DEFINITIONS = [
  {
    key: "conceptPrimer",
    id: "concept-primer",
    label: "Concept Primer",
  },
  {
    key: "lectureReading",
    id: "lecture-chapter-reading",
    label: "Lecture/Chapter Reading",
  },
  {
    key: "matchingProblemSheet",
    id: "matching-problem-sheet",
    label: "Matching Problem Sheet",
  },
  {
    key: "pastPaperAnchor",
    id: "past-paper-anchor",
    label: "Past-Paper Anchor",
  },
  {
    key: "guidedSetup",
    id: "guided-setup",
    label: "Guided Setup",
  },
  {
    key: "exactTasks",
    id: "exact-question",
    label: "Exact Question / Source",
  },
  {
    key: "diagramChecklist",
    id: "diagram-checklist",
    label: "Diagram Checklist",
  },
  {
    key: "finalTasks",
    id: "final-tasks",
    label: "Final Tasks",
  },
  {
    key: "mistakeRepair",
    id: "mistake-repair",
    label: "Mistake Repair",
  },
  {
    key: "confidenceRating",
    id: "confidence-rating",
    label: "Confidence Rating",
  },
];

function createMasterPlanSectionTasks(blockId, sectionId, taskItems) {
  return taskItems.map((taskItem, index) => {
    if (typeof taskItem === "string") {
      return {
        id: `study-plan-${blockId}-${sectionId}-task-${index + 1}`,
        title: taskItem,
      };
    }

    return {
      id: `study-plan-${blockId}-${sectionId}-task-${index + 1}`,
      title: taskItem.title,
      caption: taskItem.caption || "",
    };
  });
}

function hydrateMasterPlanBlock(rawBlock) {
  if (rawBlock.sections && rawBlock.tasks) {
    return rawBlock;
  }

  if (rawBlock.tasks && !rawBlock.conceptPrimer) {
    return {
      ...rawBlock,
      tags: Array.isArray(rawBlock.tags) ? rawBlock.tags : [],
      sections: [
        {
          id: "study-tasks",
          label: "Study Tasks",
          tasks: createMasterPlanTasks(rawBlock.id, rawBlock.tasks),
        },
      ],
      tasks: createMasterPlanTasks(rawBlock.id, rawBlock.tasks),
    };
  }

  const module = MASTER_PLAN_MODULES[rawBlock.moduleId];
  const sections = MASTER_PLAN_SECTION_DEFINITIONS.map((definition) => {
    const sectionTasks = rawBlock[definition.key];

    if (!Array.isArray(sectionTasks) || !sectionTasks.length) {
      return null;
    }

    return {
      id: definition.id,
      label: definition.label,
      tasks: createMasterPlanSectionTasks(rawBlock.id, definition.id, sectionTasks),
    };
  }).filter(Boolean);

  return {
    ...rawBlock,
    moduleLabel: module.label,
    shortModule: module.shortLabel,
    accent: module.accent,
    deadline: module.deadline,
    deadlineLabel: module.deadlineLabel,
    tags: Array.isArray(rawBlock.tags) ? rawBlock.tags : [],
    sections,
    tasks: sections.flatMap((section) => section.tasks),
  };
}

function createCondensedTopicTasks() {
  return Array.from({ length: 13 }, (_, index) => ({
    id:
      index < 10
        ? `condensed-problem-week-${index + 1}`
        : `condensed-topic-${index + 1}`,
    title: `Topic ${index + 1}`,
    caption: `Condensed Matter topic ${index + 1}.`,
  }));
}

const THESIS_SECTIONS = [
  {
    id: "abstract",
    title: "Abstract",
    wordRange: "150-180 words",
    midpoint: 165,
  },
  {
    id: "introduction",
    title: "Introduction",
    wordRange: "550-700 words",
    midpoint: 625,
  },
  {
    id: "theory",
    title: "Theory",
    wordRange: "800-950 words",
    midpoint: 875,
  },
  {
    id: "numerical-method",
    title: "Numerical Method",
    wordRange: "850-1000 words",
    midpoint: 925,
  },
  {
    id: "results",
    title: "Results",
    wordRange: "1300-1500 words",
    midpoint: 1400,
  },
  {
    id: "discussion",
    title: "Discussion",
    wordRange: "700-850 words",
    midpoint: 775,
  },
  {
    id: "conclusion",
    title: "Conclusion",
    wordRange: "150-220 words",
    midpoint: 185,
  },
];

const THESIS_TOTAL_MIDPOINT = THESIS_SECTIONS.reduce(
  (sum, section) => sum + section.midpoint,
  0
);

function createThesisSectionTasks() {
  return THESIS_SECTIONS.map((section) => {
    const thesisWeight = (section.midpoint / THESIS_TOTAL_MIDPOINT) * 100;

    return {
      id: `project-thesis-${section.id}`,
      title: section.title,
      weight: section.midpoint,
      caption: `${section.wordRange}, ${formatWeightLabel(thesisWeight)}% of thesis writing.`,
    };
  });
}

function padNumber(value) {
  return String(value).padStart(2, "0");
}

function formatDateKeyFromDate(date) {
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(
    date.getDate()
  )}`;
}

function getTodayKey() {
  return formatDateKeyFromDate(new Date());
}

function parseDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function getMonthKeyFromDate(date) {
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}`;
}

function parseMonthKey(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  return { year, month };
}

function shiftMonth(monthKey, offset) {
  const { year, month } = parseMonthKey(monthKey);
  const shifted = new Date(year, month - 1 + offset, 1);
  return getMonthKeyFromDate(shifted);
}

function formatTimeLabel(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const courses = [
  {
    id: "project",
    title: "3rd Year Project",
    accent: "#295f98",
    summary:
      "Milestone-based tracking with the assessment deadlines built in.",
    meta: [
      "Weighted by milestone importance",
      "Deadline countdowns included",
      "Assessment window ends 1 May 2026",
    ],
    groups: [
      {
        id: "project-foundations",
        title: "Literature Review & Planning",
        weight: 20,
        note: "Early groundwork that keeps the project moving with structure.",
        tasks: [
          {
            id: "project-question",
            title: "Lock the research question and scope",
          },
          {
            id: "project-literature",
            title: "Finish the core literature review",
          },
          {
            id: "project-plan",
            title: "Agree the next steps with your supervisor",
          },
        ],
      },
      {
        id: "project-implementation",
        title: "Research / Implementation",
        weight: 35,
        note: "Main calculations, experiments, coding, or analysis for the project.",
        tasks: [
          {
            id: "project-build",
            title: "Complete the main technical work",
          },
          {
            id: "project-results",
            title: "Interpret results and tidy outputs",
          },
          {
            id: "project-finalise",
            title: "Prepare the material that feeds into the report and poster",
          },
        ],
      },
      {
        id: "project-poster",
        title: "Poster Submission",
        weight: 15,
        dueDate: "2026-04-22",
        dueLabel: "22 Apr 2026",
        note: "Assessment deadline: poster submission.",
        tasks: [
          {
            id: "project-poster-draft",
            title: "Draft the poster layout and key figures",
          },
          {
            id: "project-poster-feedback",
            title: "Get feedback and revise the poster",
          },
          {
            id: "project-poster-submit",
            title: "Submit the final poster",
          },
        ],
      },
      {
        id: "project-report",
        title: "Thesis / Report Writing",
        weight: 20,
        dueDate: "2026-04-27",
        dueLabel: "27 Apr 2026",
        note: "Assessment deadline: report submission. Thesis sections are weighted by the midpoint of their target word-count ranges.",
        tasks: createThesisSectionTasks(),
      },
      {
        id: "project-presentation",
        title: "Oral & Poster Presentation",
        weight: 10,
        dueDate: "2026-04-27",
        dueLabel: "Mon 27 Apr 2026, 11:30-13:00",
        note: "Assessment slot: Monday 27 April 2026, 11:30-13:00 in Bush House (S)2.01.",
        tasks: [
          {
            id: "project-talk-points",
            title: "Prepare talking points and likely questions",
          },
          {
            id: "project-practice",
            title: "Practice the presentation",
          },
          {
            id: "project-present",
            title: "Deliver the presentation",
          },
        ],
      },
    ],
  },
  {
    id: "qm2",
    title: "Quantum Mechanics 2",
    accent: "#7f6ca8",
    examDate: "2026-05-12",
    examLabel: "12 May 2026",
    summary:
      "Weighted toward past papers, WKB revision, and the two quizzes, with the biweekly sets kept optional.",
    meta: [
      "Past papers are synced on both pages",
      "WKB is a priority topic",
      "Biweekly problem sets are optional",
      "Exam on 12 May 2026",
      "Lectures are not counted in the main percentage",
    ],
    groups: [
      {
        id: "qm2-problem-sets",
        title: "Biweekly Problem Sets",
        optional: true,
        weight: 0,
        note: "Optional practice now that the heavier focus is on WKB and past-paper revision.",
        tasks: createBiweeklySets("qm2"),
      },
      {
        id: "qm2-quizzes",
        title: "Quizzes",
        weight: 20,
        note: "Two 10-question quizzes, kept lighter so revision and past-paper work drive the main score.",
        tasks: [
          {
            id: "qm2-quiz-1",
            title: "Quiz 1",
            caption: "10 questions.",
          },
          {
            id: "qm2-quiz-2",
            title: "Quiz 2",
            caption: "10 questions.",
          },
        ],
      },
      {
        id: "qm2-revision",
        title: "Quantum Revising",
        weight: 80,
        note: "Main exam-prep block: WKB first, then heavy past-paper practice.",
        tasks: createQuantumRevisionTasks(),
      },
      {
        id: "qm2-past-papers",
        title: "Past Papers",
        tracking: "past-paper",
        weight: 100,
        note: "Shared with Quantum Revising on the course page, so these checkboxes stay in sync.",
        tasks: createQuantumPastPaperTasks(),
      },
    ],
  },
  {
    id: "relativity",
    title: "General Relativity",
    accent: "#2f7c77",
    examDate: "2026-05-27",
    examLabel: "27 May 2026",
    summary:
      "This one combines lecture-by-lecture progress with the weekly problem sets.",
    meta: [
      "Lectures are counted",
      "Problem sets are counted",
      "Past papers tracked separately",
      "Exam on 27 May 2026",
      "10 teaching weeks built in",
    ],
    groups: [
      {
        id: "gr-lectures",
        title: "Lectures",
        weight: 50,
        note: "Track each teaching week because the lecture flow matters here.",
        tasks: createWeekTasks("gr-lecture", 10, "Lecture content"),
      },
      {
        id: "gr-problem-sets",
        title: "Problem Sets",
        weight: 50,
        note: "One problem set per teaching week.",
        tasks: createWeekTasks("gr-problem", 10, "Problem set"),
      },
      {
        id: "gr-past-papers",
        title: "Past Papers",
        tracking: "past-paper",
        weight: 20,
        note: "One GR/Cosmology paper added for final exam practice.",
        tasks: [
          {
            id: "gr-paper-1",
            title: "grc-combined-exam-25.pdf",
            caption: "2025 combined GR/Cosmology past paper.",
          },
        ],
      },
    ],
  },
  {
    id: "nano",
    title: "Fundamentals of Nanotechnology",
    accent: "#bf7f31",
    examDate: "2026-05-21",
    examLabel: "21 May 2026",
    summary:
      "Weighted around one Classical Computing class, one Quantum Computing class, and the following 5 Nano problem classes.",
    meta: [
      "Classical Computing: 25%",
      "Quantum Computing: 25%",
      "Each of the next 5 problem classes: 10%",
      "Past papers tracked separately",
      "Exam on 21 May 2026",
      "10 teaching weeks built in",
    ],
    groups: [
      {
        id: "nano-classical-classes",
        title: "Classical Computing",
        weight: 25,
        note: "One Classical Computing class worth 25% of the Nano course progress.",
        tasks: [
          {
            id: "nano-problem-week-1",
            title: "Classical Computing",
            caption: "Worth 25% of the Nano course progress.",
          },
        ],
      },
      {
        id: "nano-quantum-classes",
        title: "Quantum Computing",
        weight: 25,
        note: "One Quantum Computing class worth 25% of the Nano course progress.",
        tasks: [
          {
            id: "nano-quantum-class-week-6",
            title: "Quantum Computing",
            caption: "Worth 25% of the Nano course progress.",
          },
        ],
      },
      {
        id: "nano-problem-sets",
        title: "Problem Classes",
        weight: 50,
        note: "The next 5 Nano problem classes, each worth 10% of the course progress.",
        tasks: createWeekRangeTasks("nano-problem", 6, 5, "Problem class worth 10%"),
      },
      {
        id: "nano-past-papers",
        title: "Past Papers",
        tracking: "past-paper",
        weight: 100,
        note: "Simple Nano paper tracking: Part A, Part B, and the focus line for each paper.",
        sectionLabels: { a: "Part A", b: "Part B" },
        paperEntries: NANO_PAST_PAPER_ENTRIES,
        tasks: createPaperPartTasks(NANO_PAST_PAPER_ENTRIES, {
          a: "Part A",
          b: "Part B",
        }),
      },
    ],
  },
  {
    id: "condensed",
    title: "Condensed Matter",
    accent: "#b85d58",
    examDate: "2026-05-20",
    examLabel: "20 May 2026",
    summary:
      "Built around 6CCP2000_3day_study_plan.pdf and the 2025/v3 paper: Section A safety net, Section B archetypes, then closed-book practice.",
    meta: [
      "2025/v3 drives the score",
      "Old papers are similarity practice",
      "Exam on 20 May 2026",
      "Section A safety net first",
    ],
    groups: [
      {
        id: "condensed-problem-sets",
        title: "Topics Support / Reference",
        weight: 100,
        note: "Support/reference list only. Past papers are the main visible workflow before 20 May.",
        tasks: createCondensedTopicTasks(),
      },
      {
        id: "condensed-past-papers",
        title: "2025 / v3 Main Paper",
        tracking: "past-paper",
        weight: 100,
        note: "From 6CCP2000_3day_study_plan.pdf. Old 6CCP3402 papers are similarity practice only, not the main study order.",
        sectionLabels: { a: "Section A", b: "Section B" },
        paperEntries: CONDENSED_ORDER_PAPER_ENTRIES,
        tasks: createPaperPartTasks(CONDENSED_ORDER_PAPER_ENTRIES, {
          a: "Section A",
          b: "Section B",
        }),
      },
      {
        id: "condensed-similarity-past-papers",
        title: "Old Papers - Similarity / Extra Practice",
        tracking: "past-paper",
        optional: true,
        weight: 0,
        note: "Still here for tracking, but demoted. Use these only through the similarity map after the 2025/v3 safety-net and archetype tasks.",
        sectionLabels: { a: "Section A", b: "Section B" },
        paperEntries: CONDENSED_SIMILARITY_PAPER_ENTRIES,
        tasks: createPaperPartTasks(CONDENSED_SIMILARITY_PAPER_ENTRIES, {
          a: "Section A",
          b: "Section B",
        }),
      },
    ],
  },
];

const MASTER_PLAN_MODULES = window.STUDY_PLAN_MODULES || {
  qm2: {
    label: "Quantum Mechanics 2",
    shortLabel: "QM2",
    accent: "#7f6ca8",
    deadline: "2026-05-12",
    deadlineLabel: "12 May 2026",
  },
  condensed: {
    label: "Condensed Matter",
    shortLabel: "Condensed",
    accent: "#b85d58",
    deadline: "2026-05-20",
    deadlineLabel: "20 May 2026",
  },
  nano: {
    label: "Nanotechnology",
    shortLabel: "Nano",
    accent: "#bf7f31",
    deadline: "2026-05-21",
    deadlineLabel: "21 May 2026",
  },
  gr: {
    label: "General Relativity",
    shortLabel: "GR",
    accent: "#2f7c77",
    deadline: "2026-05-27",
    deadlineLabel: "27 May 2026",
  },
  cosmology: {
    label: "Cosmology",
    shortLabel: "Cosmology",
    accent: "#7b9471",
    deadline: "2026-05-27",
    deadlineLabel: "27 May 2026",
  },
  grcosmo: {
    label: "GR/Cosmology",
    shortLabel: "GR/Cosmology",
    accent: "#628172",
    deadline: "2026-05-27",
    deadlineLabel: "27 May 2026",
  },
};

const TIMELINE_MODULES = window.TIMELINE_MODULES || {};
const TIMELINE_PHASES = window.TIMELINE_PHASES || [];
const TIMELINE_TASKS = (window.TIMELINE_TASKS || []).map((task, index) => {
  const module = TIMELINE_MODULES[task.moduleId] || {};

  return {
    ...task,
    order: index + 1,
    moduleLabel: module.label || task.moduleId,
    shortModule: module.shortLabel || task.moduleId,
    accent: module.accent || "#667085",
    courseId: module.courseId || "",
    deadline: task.deadline || module.deadline || task.plannedDate,
    deadlineLabel: module.deadlineLabel || task.deadline || task.plannedDate,
  };
});

const MASTER_PLAN_PHASES = window.STUDY_PLAN_PHASES || [
  {
    id: "phase-1",
    title: "Phase 1 - Immediate Exam Rescue Foundation",
    blocks: [
      createMasterPlanBlock({
        id: "qm2-wkb-foundations",
        order: 1,
        moduleId: "qm2",
        title: "WKB Foundations",
        priority: "Critical",
        type: "Concept",
        reason: "Lecturer said WKB is new this year and not in old past papers.",
        tasks: [
          "Learn what the WKB approximation is",
          "Learn allowed region: E > V(x)",
          "Learn forbidden region: E < V(x)",
          "Learn turning points: E = V(x)",
          "Learn p(x) = sqrt(2m(E - V(x)))",
          "Understand why WKB breaks down at turning points",
          "Learn WKB quantisation condition",
          "Learn WKB tunnelling exponential",
          "Make a one-page WKB method sheet",
          "Do one basic WKB setup question",
          "Do one WKB quantisation question",
          "Do one WKB tunnelling setup question",
          "Do the mock-style WKB question with V(x) = lambda x^4",
          "Redo the WKB mock-style question without notes",
        ],
      }),
      createMasterPlanBlock({
        id: "condensed-conventional-cells",
        order: 2,
        moduleId: "condensed",
        title: "Conventional Cells + bcc/fcc Rules",
        priority: "Critical",
        type: "Lecturer Hint",
        reason:
          "Lecturer said learn conventional cells and structures; may ask to derive bcc/fcc rules.",
        tasks: [
          "Draw simple cubic conventional cell",
          "Draw bcc conventional cell",
          "Draw fcc conventional cell",
          "Count atoms in simple cubic conventional cell",
          "Count atoms in bcc conventional cell",
          "Count atoms in fcc conventional cell",
          "Learn conventional cell vs primitive cell",
          "Write primitive vectors for bcc",
          "Write primitive vectors for fcc",
          "Derive reciprocal lattice vectors from primitive vectors",
          "Show reciprocal of bcc is fcc",
          "Show reciprocal of fcc is bcc",
          "Learn Miller indices",
          "Practise drawing cubic planes from Miller indices",
          "Learn cubic plane spacing d_hkl = a / sqrt(h^2+k^2+l^2)",
          "Practise one Miller indices question",
          "Practise one plane-spacing question",
          "Learn Brillouin zone as Wigner-Seitz cell in reciprocal space",
          "Practise k-vector equivalence using k' = k + G",
        ],
      }),
      createMasterPlanBlock({
        id: "nano-spp-propagation-length",
        order: 3,
        moduleId: "nano",
        title: "Quiz 1 Q2 SPP Propagation Length",
        priority: "Critical",
        type: "Lecturer Hint",
        reason: "Lecturer said Quiz 1 Q2 is a next exam question.",
        tasks: [
          "Understand effective refractive index n_eff = n' + i n''",
          "Learn k_spp = k0 n_eff",
          "Learn k0 = 2pi / lambda0",
          "Learn Im(k_spp) = k0 Im(n_eff)",
          "Learn intensity propagation length L = 1 / [2 Im(k_spp)]",
          "Redo Quiz 1 Q2 calculation",
          "Redo same calculation with changed wavelength",
          "Redo same calculation with changed Im(n_eff)",
          "Make one-line method sheet for SPP propagation length",
          "Add this formula to Nano formula sheet",
        ],
      }),
      createMasterPlanBlock({
        id: "gr-current-state-reset",
        order: 4,
        moduleId: "gr",
        title: "Current State Reset",
        priority: "High",
        type: "Admin / Structure",
        reason: "You have only revised up to Week 4 and missed lectures.",
        tasks: [
          "Mark GR Weeks 1-4 as reviewed",
          "Mark GR Weeks 5-7 as not reviewed",
          "Mark Cosmology Weeks 8-10 as not reviewed",
          "Create GR/Cosmology red-yellow-green topic map",
          "Add GR revision guide as core source",
          "Add problem sets 0-7 as GR problem practice",
          "Add cosmology files as Weeks 8-10 source",
          "Create GR formula sheet template",
          "Create GR diagram sheet template",
        ],
      }),
    ],
  },
  {
    id: "phase-2",
    title: "Phase 2 - Quantum High-Yield Core",
    blocks: [
      createMasterPlanBlock({
        id: "qm2-variational-method",
        order: 5,
        moduleId: "qm2",
        title: "Variational Method",
        priority: "Critical",
        type: "Concept + Problem",
        reason: "Lecturer said variational method is definitely a question.",
        tasks: [
          "Learn variational theorem",
          "Understand why variational energy is an upper bound to ground state energy",
          "Learn the standard variational recipe",
          "Practise normalising a trial wavefunction",
          "Practise calculating <T>",
          "Practise calculating <V>",
          "Practise calculating <H> = <T> + <V>",
          "Practise forming E(alpha)",
          "Practise differentiating dE/dalpha = 0",
          "Practise checking minimum vs maximum",
          "Do one simple variational question",
          "Do one Gaussian variational question",
          "Do one past-paper variational question",
          "Do the mock variational question",
          "Redo one variational question without notes",
          "Make a one-page variational method sheet",
        ],
      }),
      createMasterPlanBlock({
        id: "qm2-integral-manipulation",
        order: 6,
        moduleId: "qm2",
        title: "Integral Manipulation",
        priority: "Critical",
        type: "Skill",
        reason: "Lecturer explicitly said integrals matter.",
        tasks: [
          "Practise Gaussian normalisation integrals",
          "Practise exponential integrals",
          "Practise Gamma-style integrals",
          "Practise substitutions x = a u",
          "Practise substitutions u = x / b",
          "Practise integration by parts",
          "Practise expectation value integrals",
          "Practise kinetic energy integrals",
          "Practise using parity: odd integrals vanish",
          "Practise delta-function integrals",
          "Practise radial-style integrals if relevant",
          "Make an integral tricks sheet",
          "Do 10 short integral drills",
          "Redo the 5 worst integral drills",
        ],
      }),
      createMasterPlanBlock({
        id: "condensed-structure-factor",
        order: 7,
        moduleId: "condensed",
        title: "Structure Factor + Diffraction Rules",
        priority: "Critical",
        type: "Problem",
        reason: "Directly connected to bcc/fcc lecturer hint.",
        tasks: [
          "Learn structure factor formula S(G)",
          "Understand basis atoms and fractional coordinates",
          "Convert basis positions into phase factors",
          "Derive bcc structure factor",
          "Derive bcc selection rule: h+k+l even allowed",
          "Derive fcc structure factor",
          "Derive fcc selection rule: h,k,l all even or all odd allowed",
          "Learn systematic absences",
          "Practise fcc gold structure factor question",
          "Practise diamond structure factor if covered",
          "Practise zinc blende structure factor if covered",
          "Practise one diffraction selection-rule question from problem sheets",
          "Practise one diffraction question from past paper",
          "Make a bcc/fcc diffraction rules sheet",
        ],
      }),
      createMasterPlanBlock({
        id: "nano-quiz-1-review",
        order: 8,
        moduleId: "nano",
        title: "Quiz 1 Full Review",
        priority: "High",
        type: "Quiz / Pattern Recognition",
        reason: "Lecturer said look at quiz and past papers.",
        tasks: [
          "Review Quiz 1 Q1: SPP frequency decrease and critical angle",
          "Review Quiz 1 Q2: SPP propagation length",
          "Review Quiz 1 Q3: grating period at normal incidence",
          "Review Quiz 1 Q4: LSP vs SPP confinement",
          "Review Quiz 1 Q5: higher surrounding refractive index gives red-shift",
          "Review Quiz 1 Q6: plasma frequency to LSP resonance wavelength",
          "Review Quiz 1 Q7: plasmonic nanoparticle application",
          "Review Quiz 1 Q8: size increase gives red-shift and broadening",
          "Review Quiz 1 Q9: AFM advantages over SEM",
          "Review Quiz 1 Q10: silver/air vs gold/air effective index",
          "Create one-line answer sheet for Quiz 1",
          "Redo all calculation-based quiz questions",
          "Redo all conceptual quiz questions verbally",
        ],
      }),
    ],
  },
  {
    id: "phase-3",
    title: "Phase 3 - Quantum Past-Paper Core",
    blocks: [
      createMasterPlanBlock({
        id: "qm2-non-degenerate-perturbation",
        order: 9,
        moduleId: "qm2",
        title: "Non-Degenerate Perturbation Theory",
        priority: "Critical",
        type: "Concept + Problem",
        tasks: [
          "Learn first-order energy correction",
          "Learn first-order state correction",
          "Learn second-order energy correction",
          "Understand matrix elements",
          "Practise one first-order perturbation question",
          "Practise one second-order perturbation question",
          "Practise harmonic oscillator perturbation",
          "Practise perturbation with x, x^2, or x^4",
          "Practise identifying which states couple",
          "Make perturbation formula sheet",
        ],
      }),
      createMasterPlanBlock({
        id: "qm2-degenerate-perturbation",
        order: 10,
        moduleId: "qm2",
        title: "Degenerate Perturbation Theory",
        priority: "Critical",
        type: "Problem",
        tasks: [
          "Learn when non-degenerate perturbation fails",
          "Identify degenerate subspace",
          "Build perturbation matrix",
          "Diagonalise 2x2 perturbation matrix",
          "Interpret eigenvalues as first-order corrections",
          "Interpret eigenvectors as correct zeroth-order states",
          "Do one simple degenerate perturbation question",
          "Do one past-paper degenerate perturbation question",
          "Redo one degenerate perturbation question without notes",
        ],
      }),
      createMasterPlanBlock({
        id: "qm2-time-dependent-perturbation",
        order: 11,
        moduleId: "qm2",
        title: "Time-Dependent Perturbation Theory",
        priority: "High",
        type: "Concept + Problem",
        tasks: [
          "Learn transition amplitude formula",
          "Understand matrix element <f|H'(t)|i>",
          "Practise time integral setup",
          "Convert amplitude to probability",
          "Understand resonance condition",
          "Practise one sinusoidal perturbation question",
          "Practise one constant perturbation switched on for finite time",
          "Practise one spin/time-dependent question if in mock",
          "Make time-dependent perturbation method sheet",
        ],
      }),
      createMasterPlanBlock({
        id: "condensed-free-electron-dos",
        order: 12,
        moduleId: "condensed",
        title: "Free Electron Gas + DOS",
        priority: "Critical",
        type: "Problem",
        tasks: [
          "Learn k-space state counting",
          "Learn periodic boundary condition spacing Delta k = 2pi/L",
          "Derive 1D density of states",
          "Derive 2D density of states",
          "Derive 3D density of states",
          "Practise 2D free electron gas DOS question",
          "Derive Fermi wavevector in 1D",
          "Derive Fermi wavevector in 2D",
          "Derive Fermi wavevector in 3D",
          "Calculate Fermi energy from electron density",
          "Calculate total kinetic energy at T = 0",
          "Practise old paper DOS question",
          "Practise 2025-style DOS question",
          "Make DOS formula sheet",
        ],
      }),
      createMasterPlanBlock({
        id: "nano-spp-coupling",
        order: 13,
        moduleId: "nano",
        title: "SPP Coupling",
        priority: "Critical",
        type: "Problem",
        tasks: [
          "Learn SPP momentum mismatch idea",
          "Learn prism coupling condition",
          "Learn grating coupling condition",
          "Practise prism excitation angle question",
          "Practise critical angle trend question",
          "Practise grating period at normal incidence",
          "Practise grating period with changed n_eff",
          "Practise explaining why SPP cannot be excited directly by free-space light",
          "Make SPP coupling method sheet",
        ],
      }),
      createMasterPlanBlock({
        id: "gr-christoffel-covariant-derivative",
        order: 14,
        moduleId: "gr",
        title: "Christoffel Symbols + Covariant Derivative",
        priority: "Critical",
        type: "Problem",
        tasks: [
          "Learn vector vs dual vector",
          "Learn index notation",
          "Learn raising and lowering indices",
          "Learn covariant derivative idea",
          "Learn connection coefficients",
          "Learn Levi-Civita connection formula",
          "Understand metric compatibility",
          "Understand torsion-free assumption",
          "Compute Christoffel symbols for polar coordinates",
          "Compute Christoffel symbols for simple 2D metric",
          "Do one GR problem-set Christoffel question",
          "Make Christoffel method sheet",
        ],
      }),
    ],
  },
  {
    id: "phase-4",
    title: "Phase 4 - Quantum Completion + Maintenance of Others",
    blocks: [
      createMasterPlanBlock({
        id: "qm2-spin-angular-momentum",
        order: 15,
        moduleId: "qm2",
        title: "Spin and Angular Momentum",
        priority: "High",
        type: "Concept + Problem",
        tasks: [
          "Learn spin-1/2 basis states",
          "Learn singlet state",
          "Learn triplet states",
          "Learn addition of angular momentum idea",
          "Learn S1 . S2 identity",
          "Practise spin coupling question",
          "Practise total spin degeneracy counting",
          "Practise spin Hamiltonian question",
          "Practise one mock-style spin question",
        ],
      }),
      createMasterPlanBlock({
        id: "qm2-identical-particles",
        order: 16,
        moduleId: "qm2",
        title: "Identical Particles",
        priority: "High",
        type: "Concept + Problem",
        tasks: [
          "Learn boson symmetry rule",
          "Learn fermion antisymmetry rule",
          "Understand total wavefunction = spatial x spin",
          "Connect triplet spin to symmetric spin state",
          "Connect singlet spin to antisymmetric spin state",
          "Practise two-particle infinite well question",
          "Practise exchange symmetry question",
          "Practise Pauli exclusion reasoning",
          "Make identical-particles summary sheet",
        ],
      }),
      createMasterPlanBlock({
        id: "qm2-hunds-rules",
        order: 17,
        moduleId: "qm2",
        title: "Hund's Rules",
        priority: "Medium",
        type: "Easy Marks",
        tasks: [
          "Learn electron configuration basics",
          "Learn open shell identification",
          "Learn maximise S",
          "Learn maximise L",
          "Learn choose J for less/more than half-filled shell",
          "Practise 5 term-symbol examples",
          "Make Hund's rules mini-sheet",
        ],
      }),
      createMasterPlanBlock({
        id: "condensed-phonons",
        order: 18,
        moduleId: "condensed",
        title: "Phonons",
        priority: "Critical",
        type: "Concept + Problem",
        tasks: [
          "Learn harmonic approximation",
          "Learn monoatomic chain setup",
          "Learn acoustic branch",
          "Learn diatomic chain setup",
          "Learn acoustic vs optical branches",
          "Learn branch counting: 3N modes for N atoms in primitive cell",
          "Practise phonon branch counting question",
          "Practise identifying longitudinal and transverse modes",
          "Practise sketching phonon dispersion",
          "Practise extended zone scheme if needed",
          "Learn Debye low-temperature heat capacity",
          "Learn Dulong-Petit high-temperature limit",
          "Learn Einstein model basics",
          "Practise heat capacity sketch",
          "Practise one phonon past-paper question",
        ],
      }),
      createMasterPlanBlock({
        id: "nano-lsp-resonance",
        order: 19,
        moduleId: "nano",
        title: "LSP Resonance",
        priority: "Critical",
        type: "Concept + Problem",
        tasks: [
          "Learn LSP vs SPP difference",
          "Learn why LSP is more confined than SPP",
          "Learn Frohlich condition",
          "Learn Drude model relevance",
          "Practise plasma frequency to resonance wavelength question",
          "Practise surrounding refractive index red-shift question",
          "Practise particle-size red-shift/broadening explanation",
          "Practise plasmonic application question",
          "Make LSP summary sheet",
        ],
      }),
      createMasterPlanBlock({
        id: "gr-geodesics",
        order: 20,
        moduleId: "gr",
        title: "Geodesics",
        priority: "Critical",
        type: "Derivation + Problem",
        tasks: [
          "Learn geodesic equation conceptually",
          "Learn least action method",
          "Learn Euler-Lagrange method",
          "Set up Lagrangian from metric",
          "Identify cyclic coordinates",
          "Derive constants of motion",
          "Do one simple geodesic problem",
          "Do one Schwarzschild geodesic setup",
          "Understand affine parameter",
          "Understand massive vs massless geodesics",
          "Make geodesic method sheet",
        ],
      }),
    ],
  },
  {
    id: "phase-5",
    title: "Phase 5 - Past Paper Integration",
    blocks: [
      createMasterPlanBlock({
        id: "qm2-mock-paper",
        order: 21,
        moduleId: "qm2",
        title: "Mock Paper",
        priority: "Critical",
        type: "Past Paper",
        tasks: [
          "Attempt mock paper untimed",
          "Mark mock paper",
          "Identify WKB question type",
          "Identify variational question type",
          "Identify perturbation question type",
          "Identify spin question type",
          "Redo all wrong Section A questions",
          "Redo all wrong Section B questions",
          "Create mock-paper mistake sheet",
          "Redo mock WKB question",
          "Redo mock variational question",
        ],
      }),
      createMasterPlanBlock({
        id: "qm2-real-past-papers",
        order: 22,
        moduleId: "qm2",
        title: "Real Past Papers",
        priority: "Critical",
        type: "Past Paper",
        tasks: [
          "Attempt newest real QM2 paper targeted",
          "Review newest paper mistakes",
          "Attempt second newest paper targeted",
          "Review second newest paper mistakes",
          "Attempt one timed mixed paper",
          "Extract repeated question families",
          "Build final QM2 common methods sheet",
          "Redo worst perturbation question",
          "Redo worst variational question",
          "Redo worst spin/identical-particles question",
        ],
      }),
      createMasterPlanBlock({
        id: "condensed-2025-paper",
        order: 23,
        moduleId: "condensed",
        title: "2025 Paper",
        priority: "Critical",
        type: "Past Paper",
        tasks: [
          "Read 2025 paper structure",
          "Do Section A geometry questions",
          "Do Section A reciprocal lattice question",
          "Do Section A phonon counting question",
          "Do Section A optics/band gap question",
          "Do Section A magnetism/hysteresis question",
          "Do Section A structure factor question",
          "Do Section A metal/semiconductor question",
          "Do Section B ferromagnetism/Landau question",
          "Do Section B Bloch/band perturbation question",
          "Do Section B Drude/magnetoconductivity question",
          "Mark 2025 paper",
          "Make 2025 mistake sheet",
          "Redo worst 2025 question",
        ],
      }),
      createMasterPlanBlock({
        id: "nano-past-paper-cross-check",
        order: 24,
        moduleId: "nano",
        title: "Past Paper + Quiz Cross-Check",
        priority: "Critical",
        type: "Past Paper",
        tasks: [
          "Compare Quiz 1 topics with past papers",
          "Do past-paper SPP question",
          "Do past-paper LSP question",
          "Do past-paper AFM/SEM question",
          "Do past-paper quantum dot question",
          "Do past-paper PN junction/solar cell question",
          "Do past-paper CNT/graphene question",
          "Make Nano past-paper pattern sheet",
          "Redo the question closest to Quiz 1 Q2",
        ],
      }),
      createMasterPlanBlock({
        id: "gr-problem-sets-0-7",
        order: 25,
        moduleId: "gr",
        title: "Problem Sets 0-7",
        priority: "Critical",
        type: "Problem Sets",
        tasks: [
          "Review problem set 0",
          "Review problem set 1",
          "Review problem set 2",
          "Review problem set 3",
          "Review problem set 4",
          "Review problem set 5",
          "Review problem set 6",
          "Review problem set 7",
          "Redo one Christoffel problem",
          "Redo one geodesic problem",
          "Redo one curvature problem",
          "Redo one Einstein equation problem",
          "Redo one Schwarzschild problem",
        ],
      }),
    ],
  },
  {
    id: "phase-6",
    title: "Phase 6 - Condensed and Nano Core Expansion",
    blocks: [
      createMasterPlanBlock({
        id: "condensed-bloch-band-theory",
        order: 26,
        moduleId: "condensed",
        title: "Bloch Theorem + Band Theory",
        priority: "Critical",
        type: "Concept + Problem",
        tasks: [
          "Learn Bloch theorem",
          "Understand psi_nk(r) = exp(i k . r) u_nk(r)",
          "Understand periodicity of u_nk",
          "Understand meaning of k",
          "Understand first Brillouin zone",
          "Learn band filling logic",
          "Learn metals vs semiconductors vs insulators",
          "Learn band gap concept",
          "Practise Bloch theorem explanation",
          "Practise band filling question",
          "Practise metal/semiconductor/insulator classification",
          "Practise 2025-style band question",
        ],
      }),
      createMasterPlanBlock({
        id: "condensed-nearly-free-electrons",
        order: 27,
        moduleId: "condensed",
        title: "Nearly-Free Electrons + Perturbation",
        priority: "High",
        type: "Problem",
        tasks: [
          "Learn free electron parabola in periodic lattice",
          "Learn reduced zone scheme",
          "Learn why gaps open at zone boundaries",
          "Learn perturbation matrix idea for band splitting",
          "Practise one NFE band-gap question",
          "Practise one perturbation near Gamma-point question",
          "Practise one 2025-style band perturbation question",
        ],
      }),
      createMasterPlanBlock({
        id: "condensed-drude-hall-magnetotransport",
        order: 28,
        moduleId: "condensed",
        title: "Drude + Hall + Magnetotransport",
        priority: "High",
        type: "Problem",
        tasks: [
          "Learn Drude conductivity",
          "Learn resistivity and scattering time relation",
          "Practise scattering time calculation",
          "Learn Hall effect",
          "Practise Hall coefficient question",
          "Learn motion under E and B fields",
          "Practise magnetoconductivity tensor question",
          "Do 2025 Section B Drude/magnetotransport question",
          "Make transport formula sheet",
        ],
      }),
      createMasterPlanBlock({
        id: "nano-quantum-dots",
        order: 29,
        moduleId: "nano",
        title: "Quantum Dots",
        priority: "High",
        type: "Concept + Problem",
        tasks: [
          "Learn quantum confinement",
          "Learn exciton Bohr radius idea",
          "Learn strong vs weak confinement",
          "Learn smaller dot means larger gap",
          "Learn smaller dot means bluer emission",
          "Practise quantum dot colour ordering",
          "Practise Bohr radius calculation",
          "Practise core-shell/type I explanation",
          "Practise oxidation/trap-state explanation",
          "Make quantum dot summary sheet",
        ],
      }),
      createMasterPlanBlock({
        id: "nano-afm-sem-imaging",
        order: 30,
        moduleId: "nano",
        title: "AFM vs SEM + Imaging",
        priority: "High",
        type: "Theory",
        tasks: [
          "Learn AFM advantages",
          "Learn SEM advantages",
          "Learn axial vs lateral resolution distinction",
          "Learn why AFM can operate in liquid",
          "Learn why SEM usually needs vacuum",
          "Practise compare-and-contrast paragraph",
          "Practise quiz-style multi-select",
          "Make microscopy comparison table",
        ],
      }),
    ],
  },
  {
    id: "phase-7",
    title: "Phase 7 - GR/Cosmology Core",
    blocks: [
      createMasterPlanBlock({
        id: "gr-curvature",
        order: 31,
        moduleId: "gr",
        title: "Curvature",
        priority: "Critical",
        type: "Concept + Problem",
        tasks: [
          "Learn curvature from parallel transport",
          "Learn Riemann tensor meaning",
          "Learn Riemann tensor formula",
          "Learn Ricci tensor contraction",
          "Learn Ricci scalar",
          "Learn Einstein tensor",
          "Understand curved coordinates vs curved manifold",
          "Practise one curvature calculation",
          "Practise one Ricci tensor question",
          "Make curvature summary sheet",
        ],
      }),
      createMasterPlanBlock({
        id: "gr-einstein-equations",
        order: 32,
        moduleId: "gr",
        title: "Einstein Equations",
        priority: "Critical",
        type: "Concept + Derivation",
        tasks: [
          "Learn stress-energy tensor role",
          "Learn Einstein tensor role",
          "Learn cosmological constant term",
          "Learn full Einstein equation",
          "Learn vacuum condition T_mu_nu = 0",
          "Derive why vacuum gives R_mu_nu = 0",
          "Understand Newtonian limit idea at basic level",
          "Make Einstein equations summary sheet",
        ],
      }),
      createMasterPlanBlock({
        id: "gr-schwarzschild",
        order: 33,
        moduleId: "gr",
        title: "Schwarzschild",
        priority: "Critical",
        type: "Concept + Problem",
        tasks: [
          "Learn Schwarzschild metric",
          "Learn f(r) = 1 - rs/r",
          "Learn Schwarzschild radius",
          "Understand event horizon",
          "Understand singularity at r = 0",
          "Understand r > rs region",
          "Understand r < rs region",
          "Understand why r becomes time-like inside horizon",
          "Set up Schwarzschild geodesic Lagrangian",
          "Derive constants of motion E and L",
          "Learn effective potential idea",
          "Practise one Schwarzschild geodesic question",
        ],
      }),
      createMasterPlanBlock({
        id: "gr-tortoise-causality",
        order: 34,
        moduleId: "gr",
        title: "Tortoise Coordinate + Causality",
        priority: "High",
        type: "Concept + Diagram",
        tasks: [
          "Learn radial null paths",
          "Derive dt/dr for Schwarzschild radial light rays",
          "Understand why slope diverges at horizon",
          "Learn tortoise coordinate purpose",
          "Learn x(r) idea",
          "Understand horizon as coordinate issue",
          "Draw light cones outside horizon",
          "Draw light cones inside horizon",
          "Explain causal trapping inside black hole",
        ],
      }),
      createMasterPlanBlock({
        id: "gr-penrose-diagrams",
        order: 35,
        moduleId: "gr",
        title: "Penrose Diagrams",
        priority: "Critical",
        type: "Diagram",
        tasks: [
          "Draw Minkowski Penrose diagram",
          "Label i+",
          "Label i-",
          "Label i0",
          "Label J+",
          "Label J-",
          "Add constant r curves",
          "Add constant t curves",
          "Draw Schwarzschild Penrose diagram",
          "Label Region I",
          "Label Region II",
          "Label event horizon H+",
          "Label past horizon H-",
          "Label singularity r=0",
          "Label bifurcation sphere",
          "Explain why Region II has no future beyond r=0",
          "Redraw both diagrams from memory",
        ],
      }),
      createMasterPlanBlock({
        id: "cosmology-flrw-friedmann",
        order: 36,
        moduleId: "cosmology",
        title: "FLRW + Friedmann Equations",
        priority: "Critical",
        type: "Concept + Problem",
        tasks: [
          "Learn FLRW metric",
          "Learn scale factor a(t)",
          "Learn Hubble parameter H = a_dot/a",
          "Learn curvature k",
          "Learn Friedmann equation",
          "Learn acceleration equation",
          "Learn energy conservation equation",
          "Understand matter equation of state",
          "Understand radiation equation of state",
          "Understand cosmological constant equation of state",
          "Derive density scaling for matter",
          "Derive density scaling for radiation",
          "Practise one Friedmann equation problem",
        ],
      }),
      createMasterPlanBlock({
        id: "cosmology-density-parameters",
        order: 37,
        moduleId: "cosmology",
        title: "Density Parameters + Horizons",
        priority: "High",
        type: "Problem",
        tasks: [
          "Learn critical density",
          "Learn Omega_m",
          "Learn Omega_r",
          "Learn Omega_Lambda",
          "Learn flat universe condition",
          "Practise calculating Lambda from Omega_Lambda and H0",
          "Practise matter-dominated scale factor",
          "Practise radiation-dominated scale factor",
          "Learn particle horizon definition",
          "Practise particle horizon calculation",
          "Review cosmology 2025 solutions",
        ],
      }),
    ],
  },
  {
    id: "phase-8",
    title: "Phase 8 - Remaining Condensed/Nano Topics",
    blocks: [
      createMasterPlanBlock({
        id: "condensed-optics-band-gap",
        order: 38,
        moduleId: "condensed",
        title: "Optics and Band Gap",
        priority: "High",
        type: "Concept",
        tasks: [
          "Learn absorption coefficient interpretation",
          "Learn band gap from absorption onset",
          "Use visible photon energy table",
          "Decide transparent vs opaque",
          "Explain crystal colour from absorption",
          "Explain why metals reflect light",
          "Explain gold/copper colour if covered",
          "Practise 2025 optics question",
        ],
      }),
      createMasterPlanBlock({
        id: "condensed-semiconductors",
        order: 39,
        moduleId: "condensed",
        title: "Semiconductors",
        priority: "High",
        type: "Concept + Diagram",
        tasks: [
          "Learn intrinsic semiconductor",
          "Learn extrinsic semiconductor",
          "Learn donor levels",
          "Learn acceptor levels",
          "Learn n-type doping",
          "Learn p-type doping",
          "Learn holes",
          "Learn effective mass",
          "Draw p-n junction band diagram",
          "Explain depletion region",
          "Explain solar cell operation",
          "Practise one p-n junction past-paper question",
        ],
      }),
      createMasterPlanBlock({
        id: "condensed-magnetism",
        order: 40,
        moduleId: "condensed",
        title: "Magnetism",
        priority: "Critical",
        type: "Concept + Problem",
        tasks: [
          "Learn diamagnetism",
          "Learn paramagnetism",
          "Learn ferromagnetism",
          "Learn antiferromagnetism",
          "Learn ferrimagnetism",
          "Learn domains",
          "Learn hysteresis curve",
          "Explain residual magnetisation",
          "Explain saturation",
          "Explain neutron diffraction for magnetic structures",
          "Learn Curie temperature",
          "Learn Landau free energy expansion",
          "Minimise Landau free energy above Tc",
          "Minimise Landau free energy below Tc",
          "Sketch F(m) above and below Tc",
          "Do 2025 Landau ferromagnetism question",
        ],
      }),
      createMasterPlanBlock({
        id: "nano-pn-junctions-solar-cells",
        order: 41,
        moduleId: "nano",
        title: "PN Junctions + Solar Cells",
        priority: "High",
        type: "Diagram + Theory",
        tasks: [
          "Learn p-type and n-type regions",
          "Learn depletion region",
          "Learn built-in field",
          "Draw unbiased p-n junction",
          "Explain electron-hole pair creation",
          "Explain charge separation in solar cell",
          "Explain current direction",
          "Practise solar cell diagram",
          "Practise solar cell explanation paragraph",
        ],
      }),
      createMasterPlanBlock({
        id: "nano-organic-solar-cells",
        order: 42,
        moduleId: "nano",
        title: "Organic Solar Cells",
        priority: "Medium",
        type: "Theory",
        tasks: [
          "Learn donor/acceptor concept",
          "Learn exciton formation",
          "Learn why exciton needs interface to split",
          "Learn charge transport after separation",
          "Practise one short organic solar cell explanation",
        ],
      }),
      createMasterPlanBlock({
        id: "nano-cnts-graphene",
        order: 43,
        moduleId: "nano",
        title: "CNTs and Graphene",
        priority: "Medium",
        type: "Diagram + Theory",
        tasks: [
          "Learn carbon nanotube structure basics",
          "Learn why CNTs can be metallic or semiconducting",
          "Learn graphene band structure basics",
          "Learn Dirac cone idea",
          "Learn bilayer graphene band gap if covered",
          "Practise CNT explanation",
          "Practise graphene diagram labels",
          "Practise one past-paper CNT/graphene question",
        ],
      }),
    ],
  },
  {
    id: "phase-9",
    title: "Phase 9 - Formula Sheets and Final Review",
    blocks: [
      createMasterPlanBlock({
        id: "qm2-final-formula-mistake-sheet",
        order: 44,
        moduleId: "qm2",
        title: "Final Formula and Mistake Sheet",
        priority: "Critical",
        type: "Final Review",
        tasks: [
          "Final WKB sheet",
          "Final variational sheet",
          "Final perturbation sheet",
          "Final integral tricks sheet",
          "Final spin/identical-particles sheet",
          "Final Hund's rules sheet",
          "Final repeated mistakes sheet",
          "Redo worst WKB question",
          "Redo worst variational question",
          "Redo worst perturbation question",
          "Redo worst spin question",
        ],
      }),
      createMasterPlanBlock({
        id: "condensed-cyan-box-formulas",
        order: 45,
        moduleId: "condensed",
        title: "Cyan-Box Formula Extraction",
        priority: "Critical",
        type: "Formula Sheet",
        tasks: [
          "Extract cyan-box formulas for crystal geometry",
          "Extract cyan-box formulas for reciprocal lattice",
          "Extract cyan-box formulas for structure factor",
          "Extract cyan-box formulas for phonons",
          "Extract cyan-box formulas for free electron gas",
          "Extract cyan-box formulas for Drude/Hall",
          "Extract cyan-box formulas for band theory",
          "Extract cyan-box formulas for semiconductors",
          "Extract cyan-box formulas for magnetism",
          "Create final condensed formula sheet",
        ],
      }),
      createMasterPlanBlock({
        id: "nano-final-quiz-past-paper-sheet",
        order: 46,
        moduleId: "nano",
        title: "Final Quiz/Past-Paper Sheet",
        priority: "Critical",
        type: "Final Review",
        tasks: [
          "Final SPP propagation sheet",
          "Final SPP coupling sheet",
          "Final LSP resonance sheet",
          "Final quantum dot sheet",
          "Final AFM/SEM comparison sheet",
          "Final PN junction/solar cell diagram sheet",
          "Final CNT/graphene sheet",
          "Redo Quiz 1 Q2",
          "Redo hardest Nano past-paper question",
        ],
      }),
      createMasterPlanBlock({
        id: "grcosmo-final-formula-diagram-sheet",
        order: 47,
        moduleId: "grcosmo",
        title: "Final Formula and Diagram Sheet",
        priority: "Critical",
        type: "Final Review",
        tasks: [
          "Final tensor notation sheet",
          "Final Christoffel sheet",
          "Final geodesic sheet",
          "Final curvature sheet",
          "Final Einstein equations sheet",
          "Final Schwarzschild sheet",
          "Final tortoise coordinate sheet",
          "Final Penrose diagram sheet",
          "Final Friedmann equations sheet",
          "Final cosmology density parameters sheet",
          "Redraw Minkowski Penrose diagram from memory",
          "Redraw Schwarzschild Penrose diagram from memory",
          "Redo worst GR problem",
          "Redo worst cosmology problem",
        ],
      }),
    ],
  },
  {
    id: "phase-10",
    title: "Phase 10 - Book Backup Tasks",
    description:
      "These are not first-line tasks. Use them when past papers or problem sheets are done, or when you get stuck.",
    blocks: [
      createMasterPlanBlock({
        id: "condensed-book-lookup-backup",
        order: 48,
        moduleId: "condensed",
        title: "Book Lookup Backup",
        priority: "Medium",
        type: "Reading Backup",
        tasks: [
          "Use Simon for crystal structures and reciprocal lattice",
          "Use Simon for phonons",
          "Use Simon for free electron gas",
          "Use Simon for band theory",
          "Use Simon for semiconductors",
          "Use Simon for magnetism basics",
          "Use Kittel if Simon explanation is unclear",
          "Use Ashcroft & Mermin only for deeper clarification",
          "Use Kantorovich only if course-specific detail is needed",
        ],
      }),
    ],
  },
];

const EXACT_MASTER_PLAN_PHASES = [
  {
    id: "exact-order",
    title: "Exact File-by-File Order",
    description:
      "Open the exact file, do the named question, then record mistakes before moving to the next block.",
    blocks: [
      createMasterPlanBlock({
        id: "qm2-mock-wkb-quartic",
        order: 1,
        moduleId: "qm2",
        title: "WKB quartic potential",
        priority: "Critical",
        type: "Mock Question",
        sourceFile: "QMII_6CCP3221_Mock.pdf",
        question: "Section A, Q1.5",
        task: "Use the WKB quantisation condition to derive the energy levels for V(x) = lambda x^4.",
        reason: "Lecturer said WKB is new this year and not in the old past papers.",
        skill: "Turning points -> WKB integral -> energy quantisation.",
      }),
      createMasterPlanBlock({
        id: "condensed-2025-fcc-reciprocal-lattice",
        order: 2,
        moduleId: "condensed",
        title: "fcc reciprocal lattice and k equivalence",
        priority: "Critical",
        type: "Past Paper",
        sourceFile: "6CCP2000_v3.pdf",
        question: "Section A, Q1.2",
        task: "Calculate the reciprocal lattice vectors of fcc and test whether two k-vectors are equivalent modulo a reciprocal lattice vector.",
        reason: "This is the closest exact match to the lecturer hint about bcc/fcc rules and conventional cells.",
        skill: "fcc primitive vectors -> reciprocal lattice -> Brillouin-zone equivalence.",
      }),
      createMasterPlanBlock({
        id: "nano-aug24-spp-propagation-length",
        order: 3,
        moduleId: "nano",
        title: "SPP propagation length and prism angle",
        priority: "Critical",
        type: "Past Paper",
        sourceFile: "Fundamentals of Nanotechnology final August2024.pdf",
        question: "B2(d)(i)-(iii)",
        task: "Calculate complex k_spp, the propagation length, and the prism excitation angle for n_eff = 1.034 + 0.0028i at 600 nm.",
        reason: "Very close to the lecturer-hinted Quiz 1 Q2 propagation-length style.",
        skill: "k_spp = k0 n_eff -> Im(k_spp) -> L.",
      }),
      createMasterPlanBlock({
        id: "grc-25-christoffels-geodesics",
        order: 4,
        moduleId: "grcosmo",
        title: "Christoffels and geodesics",
        priority: "Critical",
        type: "Combined Paper",
        sourceFile: "grc-combined-exam-25.pdf",
        question: "Section B, Q2(a)",
        task: "Compute the Christoffel symbols for ds^2 = -dt^2 + e^(2t)dr^2 and write the geodesic equations.",
        reason: "Best compact Christoffel and geodesic exam template.",
        skill: "Metric -> inverse metric -> Christoffels -> geodesic equations.",
      }),
      createMasterPlanBlock({
        id: "qm2-mock-variational-method",
        order: 5,
        moduleId: "qm2",
        title: "Variational method",
        priority: "Critical",
        type: "Mock Question",
        sourceFile: "QMII_6CCP3221_Mock.pdf",
        question: "Section B, Q3(a)-(e)",
        task: "Do the Gaussian trial wavefunction variational question for the harmonic oscillator, including normalisation, E(alpha), minimisation, and the effective-Hamiltonian interpretation.",
        reason: "Lecturer said the variational method is definitely a question.",
        skill: "Normalise -> expectation value -> minimise.",
      }),
      createMasterPlanBlock({
        id: "qm2-2324-variational-theorem-oscillator",
        order: 6,
        moduleId: "qm2",
        title: "Variational theorem and oscillator",
        priority: "Critical",
        type: "Past Paper",
        sourceFile: "6CCP3221.Exam - 2023.24 P3.pdf",
        question: "Section A, Q1.2-Q1.3",
        task: "Prove the variational theorem, then use the variational method for the 1D harmonic oscillator.",
        reason: "Short Section A version of the confirmed variational topic.",
        skill: "Proof + quick variational execution.",
      }),
      createMasterPlanBlock({
        id: "condensed-2025-gold-fcc-structure-factor",
        order: 7,
        moduleId: "condensed",
        title: "gold/fcc structure factor",
        priority: "Critical",
        type: "Past Paper",
        sourceFile: "6CCP2000_v3.pdf",
        question: "Section A, Q1.6",
        task: "Simplify the structure factor using fractional coordinates and calculate S(G_hkl) for the gold fcc basis.",
        reason: "This is the closest exact task to the bcc/fcc selection-rule derivations.",
        skill: "Phase factors -> systematic absences.",
      }),
      createMasterPlanBlock({
        id: "nano-2023-full-plasmonics",
        order: 8,
        moduleId: "nano",
        title: "Full plasmonics question",
        priority: "Critical",
        type: "Past Paper",
        sourceFile: "6CCP9300_Fundamentals_of_Nanotechnology_Solutions_final_2023.pdf",
        question: "B2(a)-(b)(v)",
        task: "Explain real and imaginary parts of n_eff, calculate the SPP effective index and propagation length, work the grating coupling, and sketch the wavevectors.",
        reason: "Best full plasmonics past-paper template.",
        skill: "SPP complex index + propagation length + grating coupling.",
      }),
      createMasterPlanBlock({
        id: "qm2-2324-nondegenerate-perturbation",
        order: 9,
        moduleId: "qm2",
        title: "Non-degenerate perturbation",
        priority: "Critical",
        type: "Past Paper",
        sourceFile: "6CCP3221.Exam - 2023.24 P3.pdf",
        question: "Section A, Q1.1",
        task: "Calculate second-order energy shifts using non-degenerate perturbation theory for a 2-level Hamiltonian.",
        reason: "Fast Section A perturbation drill.",
        skill: "Second-order perturbation formula.",
      }),
      createMasterPlanBlock({
        id: "qm2-2122-nondegenerate-degenerate-perturbation",
        order: 10,
        moduleId: "qm2",
        title: "Non-degenerate + degenerate perturbation",
        priority: "Critical",
        type: "Past Paper",
        sourceFile: "6CCP3221.Exam - 2021.22 P3.pdf",
        question: "Section B, Q2(b)-(c)",
        task: "Do first-order non-degenerate perturbation for the 2D infinite well ground state, then first-order degenerate perturbation theory for the first excited state.",
        reason: "Classic infinite-well perturbation template that bridges straight into degeneracy.",
        skill: "Matrix elements -> degenerate subspace -> perturbation matrix -> eigenvalues.",
      }),
      createMasterPlanBlock({
        id: "qm2-mock-time-dependent-perturbation",
        order: 11,
        moduleId: "qm2",
        title: "Time-dependent perturbation",
        priority: "Critical",
        type: "Mock Question",
        sourceFile: "QMII_6CCP3221_Mock.pdf",
        question: "Section A, Q1.6",
        task: "Compute the first-order transition probability from |i> to |f> under lambda DeltaH(t) = V0 e^(-iwt).",
        reason: "Direct mock-style time-dependent perturbation question.",
        skill: "Amplitude integral -> probability.",
      }),
      createMasterPlanBlock({
        id: "condensed-2025-2d-dos",
        order: 12,
        moduleId: "condensed",
        title: "2D free electron DOS",
        priority: "Critical",
        type: "Past Paper",
        sourceFile: "6CCP2000_v3.pdf",
        question: "Section A, Q1.1",
        task: "Calculate the 2D free electron gas density of states and express the Fermi energy in terms of electron density.",
        reason: "Exact 2025 density-of-states question.",
        skill: "k-space counting -> DOS -> Fermi energy.",
      }),
      createMasterPlanBlock({
        id: "nano-2021-grating-spp-excitation",
        order: 13,
        moduleId: "nano",
        title: "grating SPP excitation",
        priority: "High",
        type: "Past Paper",
        sourceFile: "6CCP9930_Fundamentals_of_Nanotechnology_2020-2021_May_final Solutions.pdf",
        question: "Q1(d)(i)-(ii)",
        task: "Design the grating periodicities needed for SPP excitation at a silver/air interface.",
        reason: "Strong grating-coupling calculation practice.",
        skill: "Grating momentum matching.",
      }),
      createMasterPlanBlock({
        id: "grc-25-riemann-ricci",
        order: 14,
        moduleId: "grcosmo",
        title: "Riemann and Ricci",
        priority: "Critical",
        type: "Combined Paper",
        sourceFile: "grc-combined-exam-25.pdf",
        question: "Section B, Q2(b)-(c)",
        task: "Compute the independent Riemann components and show the Ricci tensor components for the same metric.",
        reason: "Direct curvature and Ricci calculation template.",
        skill: "Christoffels -> Riemann -> Ricci.",
      }),
      createMasterPlanBlock({
        id: "qm2-2425-identical-particles-and-spin",
        order: 15,
        moduleId: "qm2",
        title: "Identical particles and spin",
        priority: "High",
        type: "Past Paper",
        sourceFile: "6CCP3221.Exam - 2024.25 P3.pdf",
        question: "Section A, Q1.5-Q1.6",
        task: "Do the compact identical-particles infinite-well question, then the spin Hamiltonian energy levels and degeneracies question.",
        reason: "High-value short-form spin and identical-particles practice.",
        skill: "Singlet/triplet logic + degeneracy counting.",
      }),
      createMasterPlanBlock({
        id: "qm2-mock-spin-coupling",
        order: 16,
        moduleId: "qm2",
        title: "Spin coupling",
        priority: "High",
        type: "Mock Question",
        sourceFile: "QMII_6CCP3221_Mock.pdf",
        question: "Section B, Q2(a)-(e)",
        task: "Do the two spin-1 particles question on total angular momentum, the S1.S2 identity, and the spin-exchange perturbation.",
        reason: "Mock-style spin coupling question.",
        skill: "J^2 identity + spin-exchange energy splitting.",
      }),
      createMasterPlanBlock({
        id: "qm2-2324-hunds-rules",
        order: 17,
        moduleId: "qm2",
        title: "Hund's rules",
        priority: "Medium",
        type: "Past Paper",
        sourceFile: "6CCP3221.Exam - 2023.24 P3.pdf",
        question: "Section A, Q1.4",
        task: "Apply Hund's rules to boron and silicon.",
        reason: "Easy marks if the style repeats.",
        skill: "Electron configuration -> S, L, J -> term symbol.",
      }),
      createMasterPlanBlock({
        id: "condensed-2025-phonon-branch-counting",
        order: 18,
        moduleId: "condensed",
        title: "Phonon branch counting",
        priority: "Critical",
        type: "Past Paper",
        sourceFile: "6CCP2000_v3.pdf",
        question: "Section A, Q1.3",
        task: "Determine the number of phonon dispersion curves for a bcc crystal with 4n atoms in the conventional cell and identify the acoustic and optical modes.",
        reason: "Exact 2025-style phonon branch-counting question.",
        skill: "Primitive-cell atom count -> 3N branches -> acoustic vs optical.",
      }),
      createMasterPlanBlock({
        id: "nano-2021-lsp-spp-trends",
        order: 19,
        moduleId: "nano",
        title: "LSP/SPP resonance trends",
        priority: "High",
        type: "Past Paper",
        sourceFile: "6CCP9930_Fundamentals_of_Nanotechnology_2020-2021_May_final Solutions.pdf",
        question: "B4(a)-(c)",
        task: "Work through the metal permittivity sketch, LSP red-shift with dielectric environment, SPP dispersion, and the ways to vary the LSP resonance.",
        reason: "Strong LSP and SPP conceptual practice.",
        skill: "Frohlich condition + dispersion explanation.",
      }),
      createMasterPlanBlock({
        id: "gr-problems7-schwarzschild-geodesics",
        order: 20,
        moduleId: "grcosmo",
        title: "Schwarzschild geodesics",
        priority: "Critical",
        type: "Problem Set",
        sourceFile: "problems-7.pdf",
        question: "Problem 1",
        task: "Do the Schwarzschild geodesics problem from the problem set.",
        reason: "Direct problem-set task for the missing Week 6/7 content.",
        skill: "Schwarzschild metric -> constants of motion -> radial equation/effective potential.",
      }),
      createMasterPlanBlock({
        id: "qm2-2425-degenerate-perturbation",
        order: 21,
        moduleId: "qm2",
        title: "Degenerate perturbation",
        priority: "Critical",
        type: "Past Paper",
        sourceFile: "6CCP3221.Exam - 2024.25 P3.pdf",
        question: "Section B, Q2(a)-(b)",
        task: "Do the degenerate perturbation theory question for two coupled harmonic oscillators.",
        reason: "Newer paper and strong high-value degeneracy practice.",
        skill: "Degeneracy + perturbation matrix + energy shifts.",
      }),
      createMasterPlanBlock({
        id: "qm2-2122-full-variational-method",
        order: 22,
        moduleId: "qm2",
        title: "Full variational method",
        priority: "Critical",
        type: "Past Paper",
        sourceFile: "6CCP3221.Exam - 2021.22 P3.pdf",
        question: "Section B, Q3(a)-(b)(iii)",
        task: "Do the variational theorem plus the 3D harmonic oscillator Gaussian trial-wavefunction question.",
        reason: "Full long-form variational practice.",
        skill: "Proof + 3D normalisation + expectation value + minimisation.",
      }),
      createMasterPlanBlock({
        id: "condensed-2025-landau-theory",
        order: 23,
        moduleId: "condensed",
        title: "Ferromagnetic Landau theory",
        priority: "Critical",
        type: "Past Paper",
        sourceFile: "6CCP2000_v3.pdf",
        question: "Section B, Q2(a)-(c)",
        task: "Do the ferromagnetic mean-field partition function, free-energy expansion, minima above and below Tc, and phase-transition sketch.",
        reason: "Major 2025 Section B magnetism calculation.",
        skill: "Stat mech -> Landau free energy -> symmetry breaking.",
      }),
      createMasterPlanBlock({
        id: "nano-2023-quantum-dots",
        order: 24,
        moduleId: "nano",
        title: "Quantum dots",
        priority: "High",
        type: "Past Paper",
        sourceFile: "6CCP9300_Fundamentals_of_Nanotechnology_Solutions_final_2023.pdf",
        question: "Section A, Q1.5(a)-(b)",
        task: "Do the CdSe quantum-dot colour ordering, confinement explanation, oxidation effect, and core-shell protection diagrams.",
        reason: "Direct quantum-dot past-paper template.",
        skill: "Smaller dot -> larger gap -> bluer emission; oxidation and shell energy diagrams.",
      }),
      createMasterPlanBlock({
        id: "grc-25-schwarzschild-penrose-causality",
        order: 25,
        moduleId: "grcosmo",
        title: "Schwarzschild Penrose and causality",
        priority: "Critical",
        type: "Combined Paper",
        sourceFile: "grc-combined-exam-25.pdf",
        question: "Section B, Q3(a)-(b)",
        task: "Draw the Schwarzschild Carter-Penrose diagram and explain the causal-structure difference between r > rs and r < rs.",
        reason: "Direct match to the critical diagram skill in the GR guide.",
        skill: "Diagram labels + causal explanation.",
      }),
      createMasterPlanBlock({
        id: "condensed-2025-bloch-band-perturbation",
        order: 26,
        moduleId: "condensed",
        title: "Bloch theorem and band perturbation",
        priority: "Critical",
        type: "Past Paper",
        sourceFile: "6CCP2000_v3.pdf",
        question: "Section B, Q3",
        task: "Do the Bloch-theorem question on the meaning of k, the periodic u_nk, the k-dependent Hamiltonian, and perturbation near Gamma.",
        reason: "Major 2025 Section B band-theory question.",
        skill: "Bloch theorem + perturbation theory in bands.",
      }),
      createMasterPlanBlock({
        id: "condensed-problems-nfe-band-splitting",
        order: 27,
        moduleId: "condensed",
        title: "Nearly free electrons band splitting",
        priority: "High",
        type: "Problem Sheet",
        sourceFile: "ALL_problems_with_solutions.pdf",
        question: "11.5.2",
        task: "Work through the nearly-free-electrons model in 2D with band splitting.",
        reason: "Direct support for the perturbative band-structure question.",
        skill: "Degeneracy at zone boundary -> gap opening.",
      }),
      createMasterPlanBlock({
        id: "condensed-problems-drude-scattering-times",
        order: 28,
        moduleId: "condensed",
        title: "Drude scattering times",
        priority: "High",
        type: "Problem Sheet",
        sourceFile: "ALL_problems_with_solutions.pdf",
        question: "10.3",
        task: "Practise the Drude-theory scattering-time calculations.",
        reason: "Direct Drude calculation training.",
        skill: "sigma = ne^2 tau / m.",
      }),
      createMasterPlanBlock({
        id: "nano-2023-pn-organic-solar-cell",
        order: 29,
        moduleId: "nano",
        title: "PN junctions and organic solar cell",
        priority: "High",
        type: "Past Paper",
        sourceFile: "6CCP9300_Fundamentals_of_Nanotechnology_Solutions_final_2023.pdf",
        question: "B3(a)-(c)",
        task: "Do the P/N semiconductor formation, PN-junction energy diagrams, and organic PN-junction solar-cell question.",
        reason: "Repeated solar-cell and PN-junction family.",
        skill: "Band diagrams + charge-separation explanation.",
      }),
      createMasterPlanBlock({
        id: "nano-2023-cnt-graphene-dna",
        order: 30,
        moduleId: "nano",
        title: "CNT/graphene/DNA sequencing",
        priority: "Medium",
        type: "Past Paper",
        sourceFile: "6CCP9300_Fundamentals_of_Nanotechnology_Solutions_final_2023.pdf",
        question: "B3(d)-(f)",
        task: "Do the carbon nanotube configurations, graphene monolayer energy diagram, and CNT DNA sequencing question set.",
        reason: "Repeated CNT and graphene theory and diagram family.",
        skill: "CNT nomenclature + graphene diagram + application explanation.",
      }),
      createMasterPlanBlock({
        id: "gr-2025-schwarzschild-motion-effective-potential",
        order: 31,
        moduleId: "grcosmo",
        title: "Schwarzschild motion/effective potential",
        priority: "Critical",
        type: "Solution Paper",
        sourceFile: "2025 GR solutions / May 2025 GR paper",
        question: "Section B, Q2(a)-(c)",
        task: "Do the Schwarzschild particle-motion question covering Euler-Lagrange equations, conserved energy and angular momentum, and the radial effective potential.",
        reason: "Exact 2025 GR solution-paper template.",
        skill: "Schwarzschild geodesics and effective potential.",
      }),
      createMasterPlanBlock({
        id: "grc-25-cosmology-main-question",
        order: 32,
        moduleId: "grcosmo",
        title: "Cosmology particle horizon, static universe, flat condition",
        priority: "Critical",
        type: "Combined Paper",
        sourceFile: "grc-combined-exam-25.pdf",
        question: "Section B, Q4(a)-(c)",
        task: "Do the particle-horizon derivation, the static-universe reasoning, and the flat-universe density-parameter condition.",
        reason: "Main cosmology Section B question from the combined paper.",
        skill: "Horizon integral + Friedmann reasoning + density parameters.",
      }),
      createMasterPlanBlock({
        id: "condensed-2025-optical-band-gap-colour",
        order: 33,
        moduleId: "condensed",
        title: "Optical absorption/band gap/colour",
        priority: "High",
        type: "Past Paper",
        sourceFile: "6CCP2000_v3.pdf",
        question: "Section A, Q1.4",
        task: "Interpret the optical absorption coefficient, identify the band gap, and decide which colours are absorbed or not transparent.",
        reason: "Exact 2025 optics question.",
        skill: "Absorption onset -> band gap -> visible colour table.",
      }),
      createMasterPlanBlock({
        id: "condensed-2025-ferromagnetic-hysteresis",
        order: 34,
        moduleId: "condensed",
        title: "Ferromagnetic hysteresis",
        priority: "High",
        type: "Past Paper",
        sourceFile: "6CCP2000_v3.pdf",
        question: "Section A, Q1.5",
        task: "Explain the ferromagnetic hysteresis curve in terms of domains, saturation, and residual magnetisation.",
        reason: "Exact 2025 conceptual magnetism question.",
        skill: "Qualitative magnetic-domain explanation.",
      }),
      createMasterPlanBlock({
        id: "condensed-2025-band-filling-classification",
        order: 35,
        moduleId: "condensed",
        title: "Metal/semiconductor/insulator band filling",
        priority: "High",
        type: "Past Paper",
        sourceFile: "6CCP2000_v3.pdf",
        question: "Section A, Q1.7",
        task: "Classify the band filling and decide whether the system behaves as a metal, semiconductor, or insulator.",
        reason: "Compact classification practice that fits the same band-theory family as the 2025 paper.",
        skill: "Band filling -> classify metal vs semiconductor vs insulator.",
      }),
      createMasterPlanBlock({
        id: "nano-aug24-gratzel-graphene-cnts",
        order: 36,
        moduleId: "nano",
        title: "Gratzel solar cell, graphene, CNTs",
        priority: "Medium",
        type: "Past Paper",
        sourceFile: "Fundamentals of Nanotechnology final August2024.pdf",
        question: "B3(a)-(c)",
        task: "Complete the Gratzel solar-cell diagram and energy-harvesting steps, then do the graphene and CNT diagram questions in the same section.",
        reason: "Newer combined device and diagram practice.",
        skill: "Labelled diagram + energy-level explanation + diagram reproduction.",
      }),
      createMasterPlanBlock({
        id: "grc-25-lambda-dust-universe",
        order: 37,
        moduleId: "grcosmo",
        title: "Lambda calculation and dust universe",
        priority: "High",
        type: "Combined Paper",
        sourceFile: "grc-combined-exam-25.pdf",
        question: "Section A, Q1.6-Q1.7",
        task: "Calculate the observed value of Lambda using Omega_Lambda,0 and H0, then show that a flat dust universe with Lambda = 0 expands more and more slowly as it ages.",
        reason: "Short high-yield cosmology calculation set from Section A.",
        skill: "Lambda from density parameters + matter-dominated scale-factor behaviour.",
      }),
      createMasterPlanBlock({
        id: "condensed-problems-structure-factor-set",
        order: 38,
        moduleId: "condensed",
        title: "Structure factor/systematic absences",
        priority: "High",
        type: "Problem Sheet",
        sourceFile: "ALL_problems_with_solutions.pdf",
        question: "8.2, 8.4, 8.5",
        task: "Work through the diamond structure factor, the X-ray systematic absences problem, and the FeCo structure-factor question.",
        reason: "Direct support for the diffraction and selection-rule family.",
        skill: "fcc lattice + basis interference + allowed and forbidden reflections.",
      }),
      createMasterPlanBlock({
        id: "condensed-problems-monoatomic-diatomic-phonons",
        order: 39,
        moduleId: "condensed",
        title: "Monoatomic/diatomic phonons",
        priority: "High",
        type: "Problem Sheet",
        sourceFile: "ALL_problems_with_solutions.pdf",
        question: "9.1.1 and 9.2.1",
        task: "Work through the monoatomic-chain sound-wave problem and the diatomic-chain sound-velocity problem.",
        reason: "Foundation for phonon dispersion and branch interpretation.",
        skill: "Equations of motion -> dispersion -> acoustic and optical modes.",
      }),
      createMasterPlanBlock({
        id: "condensed-problems-2d-free-electron-gas",
        order: 40,
        moduleId: "condensed",
        title: "2D free electron gas",
        priority: "Critical",
        type: "Problem Sheet",
        sourceFile: "ALL_problems_with_solutions.pdf",
        question: "10.6",
        task: "Do the 2D free electron gas density-of-states problem.",
        reason: "Directly supports 2025 Section A Q1.1.",
        skill: "2D DOS and Fermi energy.",
      }),
      createMasterPlanBlock({
        id: "condensed-problems-bloch-theorem",
        order: 41,
        moduleId: "condensed",
        title: "Bloch theorem",
        priority: "High",
        type: "Problem Sheet",
        sourceFile: "ALL_problems_with_solutions.pdf",
        question: "11.3.1",
        task: "Work through the Bloch-theorem problem.",
        reason: "Supports the 2025 Section B band-theory question.",
        skill: "Periodic-potential eigenstates.",
      }),
      createMasterPlanBlock({
        id: "gr-problems7-penrose-diagrams-ii",
        order: 42,
        moduleId: "grcosmo",
        title: "Penrose diagrams II",
        priority: "Critical",
        type: "Problem Set",
        sourceFile: "problems-7.pdf",
        question: "Problem 2(a)-(c)",
        task: "Draw and label the Schwarzschild Penrose diagram, explain the inside and outside horizon causal structure, and discuss the white-hole and parallel-universe regions.",
        reason: "Problem-set version of the same high-yield Schwarzschild diagram task.",
        skill: "Penrose diagram + interpretation.",
      }),
    ],
  },
];

const CONDENSED_SUPPORT_PLAN_BLOCK_IDS = new Set([
  "condensed-conventional-cells-bcc-fcc-rules",
  "condensed-miller-indices-plane-spacing",
  "condensed-wigner-seitz-brillouin-zone-construction",
  "condensed-structure-factor-gold-fcc",
  "condensed-structure-factor-diamond-systematic-absences-feco",
  "condensed-phonon-branch-counting",
  "condensed-phonon-dispersion-interpretation",
  "condensed-monoatomic-diatomic-chain-phonons",
  "condensed-2d-free-electron-gas-dos",
  "condensed-1d-dos-drude-scattering-time",
  "condensed-problem-set-dos-drude-reinforcement",
  "condensed-bloch-theorem-band-theory",
  "condensed-bloch-theorem-basics",
  "condensed-nearly-free-electron-band-splitting",
  "condensed-effective-mass-and-holes",
  "condensed-optical-absorption-band-gap-colour",
  "condensed-metal-semiconductor-insulator-band-filling",
  "condensed-semiconductors-pn-junction-solar-cell",
  "condensed-magnetism-hysteresis",
  "condensed-magnetism-landau-ferromagnetic-transition",
  "condensed-magnetic-order-neutron-diffraction",
  "condensed-cyan-box-formula-extraction",
]);

const CONDENSED_MASTER_PACK_PLAN_BLOCKS = [
  {
    id: "condensed-3day-pass-logic",
    order: 19,
    moduleId: "condensed",
    title: "2025 / v3 Pass Logic",
    priority: "Critical",
    type: "Strategy",
    tags: ["3-Day Plan", "2025 Paper", "Exam Rescue"],
    conceptPrimer: [
      "Section A is the safety net: full Section A is 40 marks.",
      "40 marks plus roughly half of one Section B can be enough for a pass.",
      "Section B now requires answering all 3 questions.",
      "One Section B question may be unfamiliar but scaffolded; follow the sub-parts.",
      "Error propagation is forgiving, so never skip later sub-parts.",
    ],
    guidedSetup: [
      "Use 6CCP2000_3day_study_plan.pdf as the Condensed order.",
      "Use 6CCP2000_v3.pdf as the main paper.",
      "Treat old 6CCP3402 papers only as similarity practice.",
    ],
    exactTasks: ["File: 6CCP2000_3day_study_plan.pdf", "File: 6CCP2000_v3.pdf"],
    mistakeRepair: ["If stuck in Section B, write the setup and continue into later sub-parts."],
  },
  {
    id: "condensed-day-1-section-a-safety-net",
    order: 20,
    moduleId: "condensed",
    title: "Day 1 - Section A Safety Net",
    priority: "Critical",
    type: "Section A",
    tags: ["3-Day Plan", "Section A", "Safety Net"],
    conceptPrimer: [
      "These are the 40-mark safety-net topics.",
      "Aim for clean, short Section A answers before chasing old-paper extras.",
    ],
    guidedSetup: [
      "Work through each Section A topic once.",
      "Make a one-line method/formula note for each topic.",
    ],
    exactTasks: [
      "2D Free Electron Gas - g2D(E), EF",
      "Reciprocal lattice vectors and Brillouin-zone equivalence",
      "Phonon branch counting - primitive vs conventional cell",
      "Structure factor and diffraction selection rules",
      "Optical absorption, band gap, colour table",
      "Ferromagnetic hysteresis qualitative answer",
      "Metal vs insulator from electron count / band filling",
    ],
    mistakeRepair: ["Redo any Section A item that is not answerable in under 8 minutes."],
  },
  {
    id: "condensed-day-2-section-b-archetypes",
    order: 21,
    moduleId: "condensed",
    title: "Day 2 - Section B Archetypes",
    priority: "Critical",
    type: "Section B",
    tags: ["3-Day Plan", "Section B", "Archetypes"],
    conceptPrimer: [
      "Section B is now all 3 questions, so build setup fluency rather than topic-picking.",
      "The unfamiliar question should still be scaffolded by sub-parts.",
    ],
    guidedSetup: [
      "For each archetype, learn the first two setup lines cold.",
      "If arithmetic goes wrong, continue later sub-parts using your previous answer.",
    ],
    exactTasks: [
      "Drude theory -> magneto-conductivity tensor",
      "Bloch theorem + k.p perturbation theory",
      "Landau / Curie-Weiss ferromagnet",
      "Backup: 1D chain vibrations",
      "Backup: 3D Fermi sphere, Debye heat capacity, Hund's rules",
    ],
    mistakeRepair: [
      "Dry-fire the Drude tensor setup.",
      "Dry-fire the Bloch theorem derivation.",
      "Redo the Landau minimisation sketch if signs are shaky.",
    ],
  },
  {
    id: "condensed-day-3-2025-closed-book-practice",
    order: 22,
    moduleId: "condensed",
    title: "Day 3 - 2025 Closed-Book Practice",
    priority: "Critical",
    type: "Past Paper",
    tags: ["3-Day Plan", "2025 Paper", "Closed Book"],
    conceptPrimer: ["This is the main rehearsal. Do not replace it with older papers."],
    guidedSetup: ["Use only the rubric while sitting the paper.", "Mark honestly afterwards."],
    exactTasks: [
      "Sit the 2025 paper closed-book using only the rubric",
      "Mark honestly",
      "Identify two weakest topics",
      "Revisit only those topics",
      "Re-read 2025_Q2_with_solutions.pdf",
      "Dry-fire one Drude tensor setup and one Bloch theorem derivation",
    ],
    mistakeRepair: ["Turn the two weakest topics into final repair tasks."],
  },
  {
    id: "condensed-similarity-practice-map",
    order: 23,
    moduleId: "condensed",
    title: "Similarity Practice Map",
    priority: "High",
    type: "Similarity Practice",
    tags: ["3-Day Plan", "Old Papers Demoted", "Similarity Map"],
    conceptPrimer: [
      "Old 6CCP3402 papers are not the main order anymore.",
      "Use them only when they match a 2025/v3 question family.",
    ],
    guidedSetup: ["Practise the matching old question cold, then compare against the 2025 method."],
    exactTasks: [
      "A1.1 2D DOS: use 2019 Q3, resit Q1.5, problems_with_solutions_w_6.pdf",
      "A1.2 reciprocal lattice: use problems_with_solutions_w_3.pdf and w_4.pdf",
      "A1.3 phonon branches: use problems_with_solutions_w_5.pdf",
      "A1.6 structure factor: use problems_with_solutions_w_4.pdf and old CsH crystallography",
      "B4 Drude tensor: use problems_with_solutions_w_6.pdf and Homework1.pdf Problem 1.3",
      "B3 Bloch/k.p: use problems_with_solutions_w_8.pdf and Homework3.pdf",
      "B2 Landau: use 2025_Q2_with_solutions.pdf and problems_with_solutions_w_10.pdf",
      "Extra only: August 2014 B2 Drude and B4 semiconductor if time remains",
    ],
    mistakeRepair: ["Do not restart the old-paper-first order.", "Use Aug 2014 only as optional extra practice."],
  },
  {
    id: "condensed-final-cheat-sheet-checklist",
    order: 24,
    moduleId: "condensed",
    title: "Final Cheat-Sheet Checklist",
    priority: "Critical",
    type: "Formula Sheet",
    tags: ["3-Day Plan", "Formula Sheet", "Final Review"],
    conceptPrimer: ["Every item here should be recallable cold before the exam."],
    guidedSetup: ["Tick each formula/method only when you can write it without looking."],
    exactTasks: [
      "g2D(E)",
      "EF in 2D",
      "g3D(E)",
      "kF in 3D",
      "reciprocal lattice formula",
      "d_hkl = 2pi / |G_hkl|",
      "phonon branches = 3p",
      "monatomic chain dispersion",
      "NFE gap = 2|VG|",
      "Bloch theorem",
      "k.p perturbation",
      "Drude EOM",
      "cyclotron frequency",
      "Hall coefficient",
      "FCC and BCC diffraction rules",
      "Curie law",
      "Landau Tc",
      "order parameter scaling",
      "ln cosh expansion",
      "Debye low-T heat capacity",
      "Hund's rules",
      "Lande g",
    ],
    mistakeRepair: ["Anything not cold goes into the final repair pass."],
  },
];

function getMasterPlanPhases() {
  return MASTER_PLAN_PHASES.map((phase) => {
    const blocks = phase.blocks.filter(
      (block) => !CONDENSED_SUPPORT_PLAN_BLOCK_IDS.has(block.id)
    );

    return {
      ...phase,
      blocks:
        phase.id === "full-ordered-dashboard"
          ? [...blocks, ...CONDENSED_MASTER_PACK_PLAN_BLOCKS]
          : blocks,
    };
  });
}

function getMasterPlanBlocks() {
  return getMasterPlanPhases().flatMap((phase) =>
    phase.blocks.map((block) => ({
      ...hydrateMasterPlanBlock(block),
      phaseId: phase.id,
      phaseTitle: phase.title,
    }))
  );
}

function buildTaskCatalog() {
  const catalog = {};

  courses.forEach((course) => {
    course.groups.forEach((group) => {
      group.tasks.forEach((task) => {
        catalog[task.id] = {
          courseTitle: course.title,
          groupTitle: group.title,
          title: task.title,
          label: `${course.title}: ${task.title}`,
        };
      });
    });
  });

  getMasterPlanBlocks().forEach((block) => {
    block.tasks.forEach((task) => {
      catalog[task.id] = {
        courseTitle: "Master Study Plan",
        groupTitle: block.title,
        title: task.title,
        label: `Study Plan: ${block.shortModule} - ${block.title} - ${task.title}`,
      };
    });
  });

  TIMELINE_TASKS.forEach((task) => {
    catalog[task.id] = {
      courseTitle: "Strict Timeline",
      groupTitle: task.moduleLabel,
      title: task.title,
      label: `Timeline: ${task.shortModule} - ${task.title}`,
    };
  });

  return catalog;
}

const taskCatalog = buildTaskCatalog();

function getMainGroups(course) {
  return course.groups.filter((group) => group.tracking !== "past-paper");
}

function getPastPaperGroups(course) {
  return course.groups.filter((group) => group.tracking === "past-paper");
}

function getCourseById(courseId) {
  return courses.find((course) => course.id === courseId);
}

function getCourseOrderIndex(courseId) {
  return courses.findIndex((course) => course.id === courseId);
}

function getTaskAliasList(taskId) {
  return TASK_ID_ALIASES[taskId] || [];
}

function getTrackedTasks(tasks) {
  return tasks.filter((task) => !task.excludeFromProgress);
}

function isTaskListFullyComplete(tasks) {
  const trackedTasks = getTrackedTasks(tasks);
  const tasksToCheck = trackedTasks.length ? trackedTasks : tasks;

  return Boolean(tasksToCheck.length) && tasksToCheck.every((task) => getTaskCompletion(task.id));
}

function isGroupFullyComplete(group) {
  return isGroupCompletedByDeadline(group.id) || isTaskListFullyComplete(group.tasks);
}

function getRemainingRequiredTaskCount(course) {
  const requiredTasks = getMainGroups(course)
    .filter((group) => !group.optional)
    .filter((group) => !isGroupFullyComplete(group))
    .flatMap((group) => getTrackedTasks(group.tasks));

  return requiredTasks.filter((task) => !getTaskCompletion(task.id)).length;
}

function getCourseDeadlineSortKey(course) {
  if (course.examDate) {
    return course.examDate;
  }

  const datedGroups = course.groups
    .map((group) => group.dueDate)
    .filter(Boolean)
    .sort();

  return datedGroups[0] || "9999-12-31";
}

function compareCoursesByDeadline(firstCourse, secondCourse) {
  const deadlineComparison = getCourseDeadlineSortKey(firstCourse).localeCompare(
    getCourseDeadlineSortKey(secondCourse)
  );

  if (deadlineComparison !== 0) {
    return deadlineComparison;
  }

  return getCourseOrderIndex(firstCourse.id) - getCourseOrderIndex(secondCourse.id);
}

function sortCourseStatsByDeadline(courseStats) {
  return courseStats
    .slice()
    .sort((first, second) => compareCoursesByDeadline(first.course, second.course));
}

function isCourseFullyComplete(course) {
  const requiredGroups = getMainGroups(course).filter((group) => !group.optional);

  return Boolean(requiredGroups.length) && requiredGroups.every((group) => isGroupFullyComplete(group));
}

function migrateQuantumPastPaperState(targetState) {
  let recovered = 0;

  QM2_PAST_PAPER_TITLES.forEach((_, index) => {
    const parentTaskId = getQuantumPastPaperParentId(index);
    const partTaskIds = getQuantumPastPaperPartIds(parentTaskId);

    if (!targetState.tasks[parentTaskId]) {
      return;
    }

    const hasCompletedParts = partTaskIds.some((taskId) => targetState.tasks[taskId]);

    if (!hasCompletedParts) {
      partTaskIds.forEach((taskId) => {
        targetState.tasks[taskId] = true;
      });
      recovered += 1;
    }

    delete targetState.tasks[parentTaskId];
  });

  return recovered;
}

function migrateLegacyTaskState(targetState) {
  let recovered = migrateQuantumPastPaperState(targetState);

  Object.entries(TASK_ID_ALIASES).forEach(([taskId, aliases]) => {
    if (targetState.tasks[taskId]) {
      return;
    }

    if (aliases.some((alias) => targetState.tasks[alias])) {
      targetState.tasks[taskId] = true;
      recovered += 1;
    }
  });

  return recovered;
}

function getStorageServerUrl() {
  if (
    location.origin === "http://127.0.0.1:8787" ||
    location.origin === "http://localhost:8787"
  ) {
    return `${location.origin}/api/state`;
  }

  return STORAGE_SERVER_URL;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), STORAGE_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      mode: "cors",
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function loadServerState() {
  const response = await fetchWithTimeout(getStorageServerUrl(), {
    headers: {
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Server state request failed with ${response.status}`);
  }

  const payload = await response.json();
  return normalizeState(payload?.state ?? payload);
}

async function writeServerState(nextState) {
  const response = await fetchWithTimeout(getStorageServerUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ state: normalizeState(nextState) }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Server save failed with ${response.status}`);
  }

  const payload = await response.json();
  return normalizeState(payload?.state ?? payload);
}

function canAttemptServerSync() {
  return serverSyncAvailable || Date.now() >= serverSyncRetryAfter;
}

function setStorageStatus(mode) {
  storageUiState.mode = mode;
  renderStorageBanner();
}

function noteServerSyncFailure() {
  serverSyncAvailable = false;
  serverSyncRetryAfter = Date.now() + STORAGE_RETRY_DELAY_MS;
  setStorageStatus("unavailable");
  renderDashboard();
}

function cloneStateSnapshot() {
  return normalizeState({
    tasks: state.tasks,
    notes: state.notes,
    dailyLog: state.dailyLog,
    deadlines: state.deadlines,
    timeline: state.timeline,
    updatedAt: state.updatedAt,
  });
}

async function flushPendingServerSave() {
  if (!pendingServerSnapshot) {
    return;
  }

  const snapshot = pendingServerSnapshot;
  pendingServerSnapshot = null;

  try {
    const savedState = await writeServerState(snapshot);
    serverSyncAvailable = true;
    serverSyncRetryAfter = 0;
    overwriteState(savedState);
    setStorageStatus("file");
  } catch (error) {
    noteServerSyncFailure();
  }
}

function scheduleServerSave(snapshot, immediate = false) {
  if (!canAttemptServerSync()) {
    setStorageStatus("unavailable");
    return;
  }

  pendingServerSnapshot = snapshot;

  if (serverSaveTimerId) {
    window.clearTimeout(serverSaveTimerId);
  }

  setStorageStatus("syncing");

  if (immediate) {
    void flushPendingServerSave();
    return;
  }

  serverSaveTimerId = window.setTimeout(() => {
    serverSaveTimerId = null;
    void flushPendingServerSave();
  }, 300);
}

function saveState() {
  state.updatedAt = Date.now();
  const snapshot = cloneStateSnapshot();

  if (canAttemptServerSync()) {
    scheduleServerSave(snapshot);
    return;
  }

  setStorageStatus("unavailable");
}

function getStoredDailyEntry(dateKey) {
  return state.dailyLog[dateKey] || {};
}

function getTaskCompletion(taskId) {
  const quantumPartTaskIds = getQuantumPastPaperPartIds(taskId);

  if (quantumPartTaskIds.length) {
    return (
      quantumPartTaskIds.every((partTaskId) => state.tasks[partTaskId]) ||
      Boolean(state.tasks[taskId])
    );
  }

  if (state.tasks[taskId]) {
    return true;
  }

  return getTaskAliasList(taskId).some((alias) => state.tasks[alias]);
}

function getDeadlineCompletion(deadlineId) {
  return Boolean(state.deadlines[deadlineId]);
}

function setDeadlineCompletion(deadlineId, complete) {
  if (complete) {
    state.deadlines[deadlineId] = true;
  } else {
    delete state.deadlines[deadlineId];
  }

  saveState();
}

function setTaskCompletion(taskId, complete) {
  const quantumPartTaskIds = getQuantumPastPaperPartIds(taskId);

  if (quantumPartTaskIds.length) {
    quantumPartTaskIds.forEach((partTaskId) => {
      if (complete) {
        state.tasks[partTaskId] = true;
      } else {
        delete state.tasks[partTaskId];
      }

      syncTaskCompletionLog(partTaskId, complete);
    });

    delete state.tasks[taskId];
    removeTaskCompletionFromLogs(taskId);
    saveState();
    return;
  }

  const quantumParentTaskId = getQuantumPastPaperParentTaskId(taskId);

  if (quantumParentTaskId) {
    delete state.tasks[quantumParentTaskId];
    removeTaskCompletionFromLogs(quantumParentTaskId);
  }

  if (complete) {
    state.tasks[taskId] = true;
  } else {
    delete state.tasks[taskId];
  }

  syncTaskCompletionLog(taskId, complete);
  saveState();
}

function setBulkTaskCompletion(taskIds, complete) {
  taskIds.forEach((taskId) => {
    if (complete) {
      state.tasks[taskId] = true;
      return;
    }

    delete state.tasks[taskId];
    removeTaskCompletionFromLogs(taskId);
  });

  saveState();
}

function setCourseNote(courseId, note) {
  if (note) {
    state.notes[courseId] = note;
  } else {
    delete state.notes[courseId];
  }

  saveState();
}

function getDailyEntry(dateKey) {
  const storedEntry = getStoredDailyEntry(dateKey);

  return {
    done: storedEntry.done || "",
    reminder: storedEntry.reminder || "",
    completedTasks: Array.isArray(storedEntry.completedTasks)
      ? storedEntry.completedTasks
      : [],
  };
}

function hasDailyEntry(entry) {
  return Boolean(
    entry.done?.trim() || entry.reminder?.trim() || entry.completedTasks?.length
  );
}

function writeDailyEntry(dateKey, entry) {
  if (hasDailyEntry(entry)) {
    state.dailyLog[dateKey] = entry;
  } else {
    delete state.dailyLog[dateKey];
  }
}

function setDailyEntry(dateKey, field, value) {
  const nextEntry = {
    ...getDailyEntry(dateKey),
    [field]: value,
  };

  writeDailyEntry(dateKey, nextEntry);
  saveState();
}

function removeTaskCompletionFromLogs(taskId) {
  Object.keys(state.dailyLog).forEach((dateKey) => {
    const entry = getDailyEntry(dateKey);
    const filteredCompletions = entry.completedTasks.filter(
      (completion) => completion.taskId !== taskId
    );

    if (filteredCompletions.length !== entry.completedTasks.length) {
      writeDailyEntry(dateKey, {
        ...entry,
        completedTasks: filteredCompletions,
      });
    }
  });
}

function syncTaskCompletionLog(taskId, complete) {
  removeTaskCompletionFromLogs(taskId);

  if (!complete) {
    return;
  }

  const taskDetails = taskCatalog[taskId];

  if (!taskDetails) {
    return;
  }

  const dateKey = getTodayKey();
  const entry = getDailyEntry(dateKey);
  const timestamp = Date.now();

  writeDailyEntry(dateKey, {
    ...entry,
    completedTasks: [
      ...entry.completedTasks,
      {
        taskId,
        label: taskDetails.label,
        timestamp,
        timeLabel: formatTimeLabel(timestamp),
      },
    ],
  });
}

function calculateGroupProgress(group) {
  const trackedTasks = getTrackedTasks(group.tasks);
  const progressTasks = trackedTasks.length ? trackedTasks : group.tasks;

  if (isGroupCompletedByDeadline(group.id)) {
    const totalTasks = progressTasks.length || 1;

    return {
      completedTasks: totalTasks,
      totalTasks,
      ratio: 1,
      weightedContribution: group.weight,
    };
  }

  const totalTasks = progressTasks.length || 1;
  const completedTasks = progressTasks.filter((task) => getTaskCompletion(task.id)).length;
  const totalTaskWeight =
    progressTasks.reduce((sum, task) => sum + (task.weight || 1), 0) || 1;
  const completedTaskWeight = progressTasks
    .filter((task) => getTaskCompletion(task.id))
    .reduce((sum, task) => sum + (task.weight || 1), 0);
  const ratio = completedTaskWeight / totalTaskWeight;

  return {
    completedTasks,
    totalTasks,
    ratio,
    weightedContribution: ratio * group.weight,
  };
}

function calculateCourseProgress(course, groups = getMainGroups(course), options = {}) {
  const courseCompleted = options.ignoreCourseCompletion
    ? false
    : isCourseCompletedByDeadline(course.id);
  const countedGroups = groups.filter((group) => !group.optional);
  const totalWeight = countedGroups.reduce((sum, group) => sum + group.weight, 0);
  const groupStats = groups.map((group) => ({
    group,
    ...(courseCompleted
      ? {
          completedTasks: getTrackedTasks(group.tasks).length || group.tasks.length || 1,
          totalTasks: getTrackedTasks(group.tasks).length || group.tasks.length || 1,
          ratio: 1,
          weightedContribution: group.weight,
        }
      : calculateGroupProgress(group)),
  }));

  const weightedScore = groupStats.reduce(
    (sum, groupStat) =>
      groupStat.group.optional ? sum : sum + groupStat.weightedContribution,
    0
  );
  const countedTasks = countedGroups.flatMap((group) => getTrackedTasks(group.tasks));
  const completedTaskCount = courseCompleted
    ? countedTasks.length
    : countedTasks.filter((task) => getTaskCompletion(task.id)).length;

  return {
    percent:
      courseCompleted || totalWeight === 0
        ? courseCompleted
          ? 100
          : 0
        : Math.round((weightedScore / totalWeight) * 100),
    groupStats,
    completedTaskCount,
    totalTaskCount: countedTasks.length,
  };
}

function calculatePastPaperProgress(course) {
  const pastPaperGroups = getPastPaperGroups(course);

  if (!pastPaperGroups.length) {
    return null;
  }

  return {
    course,
    ...calculateCourseProgress(course, pastPaperGroups, {
      ignoreCourseCompletion: true,
    }),
  };
}

function summarizeProgressStats(courseStats) {
  const totalPercent = courseStats.reduce((sum, item) => sum + item.percent, 0);
  const average = courseStats.length ? Math.round(totalPercent / courseStats.length) : 0;
  const completedTasks = courseStats.reduce((sum, item) => sum + item.completedTaskCount, 0);
  const totalTasks = courseStats.reduce((sum, item) => sum + item.totalTaskCount, 0);

  return {
    average,
    completedTasks,
    totalTasks,
    courseStats,
  };
}

function calculateOverallProgress() {
  return summarizeProgressStats(
    courses
      .filter((course) => !isCourseCompletedByDeadline(course.id))
      .sort(compareCoursesByDeadline)
      .map((course) => ({
        course,
        ...calculateCourseProgress(course),
      }))
  );
}

function calculatePastPaperOverview(pastPaperStats) {
  const stats =
    pastPaperStats ||
    courses.map((course) => calculatePastPaperProgress(course)).filter(Boolean);

  return summarizeProgressStats(
    sortCourseStatsByDeadline(
      stats.filter((courseStat) => courseStat.totalTaskCount > 0)
    )
  );
}

function calculateCompletedOverview() {
  const completedDeadlines = getCompletedDeadlines();
  const completedArchiveItems = getCompletedArchiveItems();
  const completedStudyPlanItems = getCompletedStudyPlanItems();
  const standaloneCourses = courses.filter((course) => !course.examDate);
  const examCourses = courses.filter((course) => course.examDate);
  const totalCompletableItems =
    getAllDeadlineItems().length +
      standaloneCourses.length +
      examCourses.length +
      getMasterPlanBlocks().length || 1;
  const completedItemCount = completedArchiveItems.length + completedStudyPlanItems.length;

  return {
    average: Math.round((completedItemCount / totalCompletableItems) * 100),
    completedTasks: completedItemCount,
    totalTasks: totalCompletableItems,
    courseStats: completedArchiveItems.map((item) => ({
      course: {
        title: item.title,
        accent: item.accent,
      },
      percent: 100,
      completedTaskCount: 1,
      totalTaskCount: 1,
    })),
    completedDeadlines,
    completedArchiveItems,
    completedStudyPlanItems,
  };
}

function calculateMasterPlanBlockProgress(block) {
  const totalTasks = block.tasks.length || 1;
  const completedTasks = block.tasks.filter((task) => getTaskCompletion(task.id)).length;
  const ratio = completedTasks / totalTasks;

  return {
    completedTasks,
    totalTasks,
    ratio,
    percent: Math.round(ratio * 100),
  };
}

function calculateMasterPlanProgress() {
  const planPhases = getMasterPlanPhases();
  const allBlocks = getMasterPlanBlocks();
  const blockStats = allBlocks
    .map((block) => ({
      block,
      ...calculateMasterPlanBlockProgress(block),
    }))
    .sort((first, second) => first.block.order - second.block.order);
  const completedTasks = blockStats.reduce(
    (sum, blockStat) => sum + blockStat.completedTasks,
    0
  );
  const totalTasks = blockStats.reduce((sum, blockStat) => sum + blockStat.totalTasks, 0);
  const phaseStats = planPhases.map((phase) => {
    const stats = blockStats.filter((blockStat) => blockStat.block.phaseId === phase.id);
    const phaseCompletedTasks = stats.reduce(
      (sum, blockStat) => sum + blockStat.completedTasks,
      0
    );
    const phaseTotalTasks = stats.reduce((sum, blockStat) => sum + blockStat.totalTasks, 0);

    return {
      phase,
      blockStats: stats,
      completedTasks: phaseCompletedTasks,
      totalTasks: phaseTotalTasks,
      percent: phaseTotalTasks
        ? Math.round((phaseCompletedTasks / phaseTotalTasks) * 100)
        : 0,
    };
  });
  const moduleStats = Object.values(
    blockStats.reduce((accumulator, blockStat) => {
      const moduleId = blockStat.block.moduleId;

      if (!accumulator[moduleId]) {
        accumulator[moduleId] = {
          moduleId,
          course: {
            title: blockStat.block.moduleLabel,
            accent: blockStat.block.accent,
          },
          percent: 0,
          completedTaskCount: 0,
          totalTaskCount: 0,
        };
      }

      accumulator[moduleId].completedTaskCount += blockStat.completedTasks;
      accumulator[moduleId].totalTaskCount += blockStat.totalTasks;

      return accumulator;
    }, {})
  )
    .map((moduleStat) => ({
      ...moduleStat,
      percent: moduleStat.totalTaskCount
        ? Math.round((moduleStat.completedTaskCount / moduleStat.totalTaskCount) * 100)
        : 0,
    }))
    .sort(
      (first, second) =>
        Object.keys(MASTER_PLAN_MODULES).indexOf(first.moduleId) -
        Object.keys(MASTER_PLAN_MODULES).indexOf(second.moduleId)
    );
  const deadlineStats = Object.values(
    blockStats.reduce((accumulator, blockStat) => {
      const deadlineKey = blockStat.block.deadline;

      if (!accumulator[deadlineKey]) {
        accumulator[deadlineKey] = {
          deadline: blockStat.block.deadline,
          deadlineLabel: blockStat.block.deadlineLabel,
          completedTasks: 0,
          totalTasks: 0,
        };
      }

      accumulator[deadlineKey].completedTasks += blockStat.completedTasks;
      accumulator[deadlineKey].totalTasks += blockStat.totalTasks;

      return accumulator;
    }, {})
  )
    .map((deadlineStat) => ({
      ...deadlineStat,
      percent: deadlineStat.totalTasks
        ? Math.round((deadlineStat.completedTasks / deadlineStat.totalTasks) * 100)
        : 0,
    }))
    .sort((first, second) => new Date(first.deadline) - new Date(second.deadline));
  const criticalBlockStats = blockStats.filter(
    (blockStat) => blockStat.block.priority === "Critical"
  );
  const criticalCompletedTasks = criticalBlockStats.reduce(
    (sum, blockStat) => sum + blockStat.completedTasks,
    0
  );
  const criticalTotalTasks = criticalBlockStats.reduce(
    (sum, blockStat) => sum + blockStat.totalTasks,
    0
  );
  const todayKey = getTodayKey();
  const missedCriticalBlocks = criticalBlockStats.filter(
    (blockStat) =>
      blockStat.block.deadline < todayKey && blockStat.completedTasks < blockStat.totalTasks
  );

  return {
    average: totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0,
    completedTasks,
    totalTasks,
    courseStats: moduleStats,
    blockStats,
    phaseStats,
    moduleStats,
    deadlineStats,
    criticalTaskPercent: criticalTotalTasks
      ? Math.round((criticalCompletedTasks / criticalTotalTasks) * 100)
      : 0,
    criticalCompletedTasks,
    criticalTotalTasks,
    missedCriticalBlocks,
    nextBlocks: blockStats.filter(
      (blockStat) => blockStat.completedTasks < blockStat.totalTasks
    ),
  };
}

function formatWeightLabel(weight) {
  const rounded = Math.round(weight * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatToday() {
  return new Date().toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatSelectedDate(dateKey) {
  return parseDateKey(dateKey).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatMonthLabel(monthKey) {
  const { year, month } = parseMonthKey(monthKey);
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

function daysUntil(dateString) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDate = new Date(`${dateString}T00:00:00`);
  const difference = targetDate.getTime() - today.getTime();
  return Math.round(difference / (1000 * 60 * 60 * 24));
}

function deadlineStatusLabel(daysLeft) {
  if (daysLeft < 0) {
    return {
      label: `${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? "" : "s"} overdue`,
      className: "deadline-pill--urgent",
    };
  }

  if (daysLeft <= 7) {
    return {
      label: `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`,
      className: "deadline-pill--urgent",
    };
  }

  if (daysLeft <= 21) {
    return {
      label: `${daysLeft} days left`,
      className: "deadline-pill--soon",
    };
  }

  return {
    label: `${daysLeft} days left`,
    className: "deadline-pill--safe",
  };
}

function getProjectDeadlines() {
  return [
    {
      id: "deadline-project-poster",
      title: "Poster Submission",
      date: "2026-04-22",
      dateLabel: "22 April 2026",
      copy: "Final poster submission for the 3rd Year Project.",
      relatedGroupId: "project-poster",
    },
    {
      id: "deadline-project-report",
      title: "Report Submission",
      date: "2026-04-27",
      dateLabel: "27 April 2026",
      copy: "Final project report submission.",
      relatedGroupId: "project-report",
    },
    {
      id: "deadline-project-presentation",
      title: "Oral and Poster Presentation",
      date: "2026-04-27",
      dateLabel: "Monday 27 April 2026, 11:30-13:00",
      copy: "Presentation slot in Bush House (S)2.01.",
      relatedGroupId: "project-presentation",
    },
  ];
}

function getExamDeadlines() {
  return courses
    .filter((course) => course.examDate)
    .map((course) => ({
      id: `deadline-exam-${course.id}`,
      title: course.title,
      date: course.examDate,
      dateLabel: course.examLabel,
      copy: `${course.title} exam.`,
      relatedCourseId: course.id,
      accent: course.accent,
    }))
    .sort((first, second) => new Date(first.date) - new Date(second.date));
}

function getAllDeadlineItems() {
  return [...getProjectDeadlines(), ...getExamDeadlines()];
}

function isDeadlineItemCompleted(deadline) {
  if (getDeadlineCompletion(deadline.id)) {
    return true;
  }

  if (deadline.relatedGroupId) {
    const projectCourse = getCourseById("project");
    const relatedGroup = projectCourse?.groups.find((group) => group.id === deadline.relatedGroupId);

    return relatedGroup ? isTaskListFullyComplete(relatedGroup.tasks) : false;
  }

  if (deadline.relatedCourseId && deadline.date < getTodayKey()) {
    return true;
  }

  return false;
}

function isGroupCompletedByDeadline(groupId) {
  return getProjectDeadlines().some(
    (deadline) =>
      deadline.relatedGroupId === groupId && isDeadlineItemCompleted(deadline)
  );
}

function isCourseCompletedByDeadline(courseId) {
  const course = getCourseById(courseId);

  if (!course) {
    return false;
  }

  if (isCourseFullyComplete(course)) {
    return true;
  }

  return getExamDeadlines().some(
    (deadline) =>
      deadline.relatedCourseId === courseId && isDeadlineItemCompleted(deadline)
  );
}

function isCourseExamCompleted(courseId) {
  return getExamDeadlines().some(
    (deadline) =>
      deadline.relatedCourseId === courseId && isDeadlineItemCompleted(deadline)
  );
}

function getActiveProjectDeadlines() {
  return getProjectDeadlines().filter(
    (deadline) => !isDeadlineItemCompleted(deadline)
  );
}

function getActiveExamDeadlines() {
  return getExamDeadlines().filter(
    (deadline) => !isDeadlineItemCompleted(deadline)
  );
}

function getCompletedDeadlines() {
  return getAllDeadlineItems().filter((deadline) => isDeadlineItemCompleted(deadline));
}

function getCompletedArchiveItems() {
  const projectCourse = courses.find((course) => course.id === "project");
  const archivedCompletedCourses = courses
    .filter((course) => isCourseFullyComplete(course))
    .filter((course) => {
      if (!course.examDate) {
        return true;
      }

      const examDeadline = getExamDeadlines().find(
        (deadline) => deadline.relatedCourseId === course.id
      );

      return examDeadline ? !isDeadlineItemCompleted(examDeadline) : true;
    })
    .map((course) => {
      const groupDueDates = course.groups
        .map((group) => group.dueDate)
        .filter(Boolean)
        .sort();
      const latestDate = groupDueDates[groupDueDates.length - 1] || "";
      const latestLabel =
        course.examLabel ||
        course.groups
          .filter((group) => group.dueDate === latestDate)
          .map((group) => group.dueLabel)
          .filter(Boolean)[0] ||
        latestDate;

      return {
        id: `completed-course-${course.id}`,
        title: course.title,
        subtitle: course.examDate ? "Exam prep completed" : "Course completed",
        date: course.examDate || latestDate,
        detail: latestLabel || "All tracked sections complete",
        note: course.examDate
          ? "All tracked prep for this exam is complete."
          : "All tracked sections for this course are complete.",
        accent: course.accent,
      };
    });
  const archivedProjectItems = getProjectDeadlines()
    .filter((deadline) => isDeadlineItemCompleted(deadline))
    .map((deadline) => {
      const group = projectCourse?.groups.find(
        (candidateGroup) => candidateGroup.id === deadline.relatedGroupId
      );

      return {
        id: deadline.id,
        title: deadline.title,
        subtitle: projectCourse?.title || "3rd Year Project",
        date: deadline.date,
        detail: deadline.dateLabel,
        note: group?.note || deadline.copy,
        accent: projectCourse?.accent || "#295f98",
      };
    });

  const archivedCourseItems = getExamDeadlines()
    .filter((deadline) => isDeadlineItemCompleted(deadline))
    .map((deadline) => {
      const course = getCourseById(deadline.relatedCourseId);
      const remainingTaskCount = course ? getRemainingRequiredTaskCount(course) : 0;
      const archivedByDateOnly =
        deadline.relatedCourseId &&
        deadline.date < getTodayKey() &&
        !getDeadlineCompletion(deadline.id);

      let note = deadline.copy;

      if (remainingTaskCount > 0) {
        note = archivedByDateOnly
          ? `${deadline.copy} Archived automatically after the exam date with ${remainingTaskCount} unchecked prep item${
              remainingTaskCount === 1 ? "" : "s"
            } left.`
          : `${deadline.copy} Archived with ${remainingTaskCount} unchecked prep item${
              remainingTaskCount === 1 ? "" : "s"
            } left.`;
      }

      return {
        id: deadline.id,
        title: deadline.title,
        subtitle: archivedByDateOnly ? "Exam date passed" : "Exam completed",
        date: deadline.date,
        detail: deadline.dateLabel,
        note,
        accent: deadline.accent || "#295f98",
      };
    });

  return [...archivedCompletedCourses, ...archivedProjectItems, ...archivedCourseItems].sort(
    (first, second) => new Date(first.date) - new Date(second.date)
  );
}

function getCompletedStudyPlanItems() {
  return getMasterPlanBlocks()
    .map((block) => ({
      block,
      ...calculateMasterPlanBlockProgress(block),
    }))
    .filter((blockStat) => blockStat.completedTasks >= blockStat.totalTasks)
    .sort((first, second) => first.block.order - second.block.order);
}

function buildCalendarDays(monthKey) {
  const { year, month } = parseMonthKey(monthKey);
  const firstDayOfMonth = new Date(year, month - 1, 1);
  const mondayOffset = (firstDayOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(year, month - 1, 1 - mondayOffset);

  return Array.from({ length: 42 }, (_, index) => {
    const current = new Date(gridStart);
    current.setDate(gridStart.getDate() + index);
    const dateKey = formatDateKeyFromDate(current);
    const entry = getDailyEntry(dateKey);

    return {
      dateKey,
      dayNumber: current.getDate(),
      isOutsideMonth: current.getMonth() !== month - 1,
      isToday: dateKey === getTodayKey(),
      isSelected: dateKey === uiState.selectedDate,
      hasEntry: hasDailyEntry(entry),
      preview: getDailyPreview(entry),
    };
  });
}

function countEntriesInMonth(monthKey) {
  return Object.entries(state.dailyLog).filter(
    ([dateKey, entry]) => dateKey.startsWith(monthKey) && hasDailyEntry(entry)
  ).length;
}

function getDailyPreview(entry) {
  if (entry.reminder?.trim()) {
    return entry.reminder.trim();
  }

  if (entry.done?.trim()) {
    return entry.done.trim();
  }

  if (entry.completedTasks.length === 1) {
    return entry.completedTasks[0].label;
  }

  if (entry.completedTasks.length > 1) {
    return `${entry.completedTasks.length} tasks completed`;
  }

  return "";
}

function addDaysToDateKey(dateKey, offset) {
  const date = parseDateKey(dateKey);
  date.setDate(date.getDate() + offset);
  return formatDateKeyFromDate(date);
}

function getTimelineEnergy(dateKey = getTodayKey()) {
  return state.timeline.energyByDate[dateKey] || "normal";
}

function setTimelineEnergy(dateKey, energy) {
  state.timeline.energyByDate[dateKey] = energy;
  saveState();
}

function getTimelineBaseDate(task) {
  return state.timeline.effectiveDates[task.id] || task.plannedDate;
}

function isTimelineTaskSkipped(taskId) {
  return Boolean(state.timeline.skipped[taskId]);
}

function isTimelineTaskArchivedByExam(task) {
  if (!task.courseId || state.timeline.reopenedModules[task.moduleId]) {
    return false;
  }

  const examDeadlineId = `deadline-exam-${task.courseId}`;
  const moduleExamDone =
    getDeadlineCompletion(examDeadlineId) ||
    (task.deadline && task.deadline < getTodayKey());

  return moduleExamDone && !getTaskCompletion(task.id);
}

function getTimelineEffectiveDate(task) {
  const baseDate = getTimelineBaseDate(task);

  if (
    getTaskCompletion(task.id) ||
    isTimelineTaskSkipped(task.id) ||
    isTimelineTaskArchivedByExam(task)
  ) {
    return baseDate;
  }

  return baseDate < getTodayKey() ? getTodayKey() : baseDate;
}

function getTimelineDelayCount(task) {
  const effectiveDate = getTimelineEffectiveDate(task);
  const plannedDate = parseDateKey(task.plannedDate);
  const activeDate = parseDateKey(effectiveDate);
  const dayDelay = Math.max(
    0,
    Math.round((activeDate.getTime() - plannedDate.getTime()) / (1000 * 60 * 60 * 24))
  );

  return Math.max(dayDelay, state.timeline.moveCounts[task.id] || 0);
}

function getTimelineActiveTasks() {
  return TIMELINE_TASKS.filter(
    (task) =>
      !getTaskCompletion(task.id) &&
      !isTimelineTaskSkipped(task.id) &&
      !isTimelineTaskArchivedByExam(task)
  ).sort((first, second) => {
    const dateComparison = getTimelineEffectiveDate(first).localeCompare(
      getTimelineEffectiveDate(second)
    );

    return dateComparison || first.order - second.order;
  });
}

function getTimelineTasksForDate(dateKey) {
  return getTimelineActiveTasks().filter(
    (task) => getTimelineEffectiveDate(task) === dateKey
  );
}

function getTimelineShortMaintenanceTask(tasks) {
  return tasks.find(
    (task) =>
      task.priority !== "Critical" &&
      (task.estimatedMinutes <= 60 ||
        /maintenance|formula|recall|admin/i.test(`${task.type} ${task.title}`))
  );
}

function getTimelineDisplayTasksForDate(dateKey) {
  const tasks = getTimelineTasksForDate(dateKey);

  if (getTimelineEnergy(dateKey) !== "tired") {
    return tasks;
  }

  const criticalTasks = tasks.filter((task) => task.priority === "Critical");
  const shortMaintenanceTask = getTimelineShortMaintenanceTask(tasks);

  return shortMaintenanceTask
    ? [...criticalTasks, shortMaintenanceTask]
    : criticalTasks;
}

function moveTimelineTaskToDate(taskId, dateKey, countAsDelay = true) {
  state.timeline.effectiveDates[taskId] = dateKey;

  if (countAsDelay) {
    state.timeline.moveCounts[taskId] = (state.timeline.moveCounts[taskId] || 0) + 1;
  }
}

function moveTimelineTaskToTomorrow(taskId) {
  moveTimelineTaskToDate(taskId, addDaysToDateKey(getTodayKey(), 1));
  saveState();
}

function moveUnfinishedTimelineTasksToTomorrow(dateKey = getTodayKey()) {
  getTimelineTasksForDate(dateKey).forEach((task) => {
    moveTimelineTaskToDate(task.id, addDaysToDateKey(dateKey, 1));
  });
  saveState();
}

function pullNextTimelineTaskForward(dateKey = getTodayKey()) {
  const nextTask = getTimelineActiveTasks().find(
    (task) => getTimelineEffectiveDate(task) > dateKey
  );

  if (!nextTask) {
    return;
  }

  moveTimelineTaskToDate(nextTask.id, dateKey, false);
  saveState();
}

function markTimelineTaskSkipped(taskId) {
  const task = TIMELINE_TASKS.find((candidate) => candidate.id === taskId);

  if (!task) {
    return;
  }

  if (
    task.priority === "Critical" &&
    !window.confirm("Skip this Critical task? It will leave the rolling queue.")
  ) {
    return;
  }

  state.timeline.skipped[taskId] = true;
  removeTaskCompletionFromLogs(taskId);
  saveState();
}

function markTimelineDayTired(dateKey = getTodayKey()) {
  state.timeline.energyByDate[dateKey] = "tired";

  const visibleTaskIds = new Set(
    getTimelineDisplayTasksForDate(dateKey).map((task) => task.id)
  );

  getTimelineTasksForDate(dateKey).forEach((task) => {
    if (!visibleTaskIds.has(task.id)) {
      moveTimelineTaskToDate(task.id, addDaysToDateKey(dateKey, 1));
    }
  });

  saveState();
}

function markTimelineDayGood(dateKey = getTodayKey()) {
  setTimelineEnergy(dateKey, "good");
}

function reopenTimelineModule(moduleId) {
  state.timeline.reopenedModules[moduleId] = true;
  saveState();
}

function formatTimelineDuration(minutes) {
  if (!minutes) {
    return "Exam/admin";
  }

  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function getTimelineMinimumRule(dateKey) {
  if (dateKey >= "2026-05-05" && dateKey <= "2026-05-12") {
    return {
      title: "Minimum viable day before QM2",
      items: [
        "1 hour QM2",
        "1 hour Condensed or GR depending on the planned day",
        "Move the rest to tomorrow",
      ],
    };
  }

  if (dateKey >= "2026-05-13" && dateKey <= "2026-05-19") {
    return {
      title: "Minimum viable day during Condensed + Nano war week",
      items: ["2 hours Condensed", "45 minutes Nano", "Move the rest to tomorrow"],
    };
  }

  if (dateKey >= "2026-05-22" && dateKey <= "2026-05-26") {
    return {
      title: "Minimum viable day during GR rescue week",
      items: [
        "2.5 hours GR/Cosmology",
        "Redraw or rewrite one key formula or diagram",
        "Move the rest to tomorrow",
      ],
    };
  }

  if (dateKey === "2026-05-20" || dateKey === "2026-05-21") {
    return {
      title: "Exam-day rule",
      items: ["Protect the exam", "Only final review or admin outside the exam"],
    };
  }

  return {
    title: "Rolling queue rule",
    items: ["Do today's queue first", "Pull forward only when you are not tired"],
  };
}

function isTimelineTaskUrgent(task) {
  if (getTaskCompletion(task.id) || !task.deadline) {
    return false;
  }

  const daysLeft = daysUntil(task.deadline);
  return daysLeft >= 0 && daysLeft <= 2;
}

function isFilePersistenceActive() {
  return serverSyncAvailable;
}

function getPersistenceDisabledAttribute() {
  return isFilePersistenceActive() ? "" : "disabled";
}

function renderStorageBanner() {
  const banner = document.getElementById("storage-banner");

  if (!banner) {
    return;
  }

  const recoveredMarkup = storageUiState.recoveredLegacyTasks
    ? `<span class="storage-banner__extra">Recovered ${
        storageUiState.recoveredLegacyTasks
      } renamed task${
        storageUiState.recoveredLegacyTasks === 1 ? "" : "s"
      } from an older tracker version.</span>`
    : "";

  const variants = {
    loading: {
      title: "Loading file data",
      message: "Reading your tracker state from progress-state.json.",
    },
    syncing: {
      title: "Saving to file",
      message: "Your latest changes are being written to progress-state.json.",
    },
    file: {
      title: "File save active",
      message:
        "This tracker is reading from and writing to data/progress-state.json.",
    },
    unavailable: {
      title: "File save unavailable",
      message:
        "Start the tracker with <code>start-tracker.command</code> or <code>node server.js</code>. Editing is locked until the file-backed save is available.",
    },
  };

  const activeVariant = variants[storageUiState.mode] || variants.unavailable;

  banner.className = `storage-banner storage-banner--${storageUiState.mode}`;
  banner.innerHTML = `
    <strong>${activeVariant.title}</strong>
    <span>${activeVariant.message}</span>
    ${recoveredMarkup}
  `;
}

function renderTimelineTaskCards(tasks) {
  const persistenceDisabledAttribute = getPersistenceDisabledAttribute();

  if (!tasks.length) {
    return `
      <article class="timeline-empty-card">
        <strong>Nothing queued here.</strong>
        <p>The rolling queue will fill this view when tasks land here.</p>
      </article>
    `;
  }

  return tasks
    .map((task) => {
      const effectiveDate = getTimelineEffectiveDate(task);
      const delayCount = getTimelineDelayCount(task);
      const urgent = isTimelineTaskUrgent(task);
      const delayedCritical = task.priority === "Critical" && delayCount > 2;
      const tagsMarkup = (task.tags || [])
        .map((tag) => `<span class="meta-pill">${escapeHtml(tag)}</span>`)
        .join("");
      const detailsMarkup = (task.details || [])
        .map((detail) => `<li>${escapeHtml(detail)}</li>`)
        .join("");
      const exactMarkup = (task.exact || [])
        .map((exactItem) => `<li>${escapeHtml(exactItem)}</li>`)
        .join("");

      return `
        <article
          class="timeline-task ${urgent ? "timeline-task--urgent" : ""} ${
            delayedCritical ? "timeline-task--delayed-critical" : ""
          }"
          style="--course-accent: ${task.accent}"
        >
          <div class="timeline-task__top">
            <label class="timeline-task__check">
              <input
                type="checkbox"
                data-task-id="${task.id}"
                ${getTaskCompletion(task.id) ? "checked" : ""}
                ${persistenceDisabledAttribute}
              />
              <span>
                <span class="timeline-task__title">${escapeHtml(task.title)}</span>
                <span class="timeline-task__meta">${escapeHtml(
                  `${task.shortModule} • ${task.priority} • ${task.type} • ${formatTimelineDuration(
                    task.estimatedMinutes
                  )}`
                )}</span>
              </span>
            </label>
            <div class="timeline-task__date">
              <span>${escapeHtml(formatSelectedDate(effectiveDate))}</span>
              ${
                task.plannedDate !== effectiveDate
                  ? `<small>planned ${escapeHtml(formatSelectedDate(task.plannedDate))}</small>`
                  : ""
              }
            </div>
          </div>
          <div class="course-meta">
            <span class="meta-pill">Deadline ${escapeHtml(task.deadlineLabel)}</span>
            ${tagsMarkup}
          </div>
          ${detailsMarkup ? `<ul class="timeline-task__list">${detailsMarkup}</ul>` : ""}
          ${
            exactMarkup
              ? `<div class="timeline-exact"><strong>Exact file/question</strong><ul class="timeline-task__list">${exactMarkup}</ul></div>`
              : ""
          }
          ${
            delayedCritical
              ? '<p class="timeline-warning">Critical task delayed multiple times.</p>'
              : ""
          }
          ${
            urgent
              ? '<p class="timeline-warning timeline-warning--urgent">Deadline is within 48 hours.</p>'
              : ""
          }
          <div class="timeline-task__actions">
            <button type="button" data-timeline-move-task="${task.id}" ${persistenceDisabledAttribute}>Move to tomorrow</button>
            <button type="button" data-timeline-skip-task="${task.id}" ${persistenceDisabledAttribute}>Mark as skipped</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderTimelineTaskGroup(title, tasks, note = "") {
  return `
    <section class="timeline-group">
      <div class="timeline-group__header">
        <h3>${escapeHtml(title)}</h3>
        ${note ? `<p>${escapeHtml(note)}</p>` : ""}
      </div>
      <div class="timeline-task-list">
        ${renderTimelineTaskCards(tasks)}
      </div>
    </section>
  `;
}

function groupTimelineTasks(tasks, keyGetter) {
  return tasks.reduce((groups, task) => {
    const key = keyGetter(task);

    if (!groups[key]) {
      groups[key] = [];
    }

    groups[key].push(task);
    return groups;
  }, {});
}

function getTimelineArchivedModuleStats() {
  return Object.entries(TIMELINE_MODULES)
    .map(([moduleId, module]) => {
      const hiddenTasks = TIMELINE_TASKS.filter(
        (task) => task.moduleId === moduleId && isTimelineTaskArchivedByExam(task)
      );

      return {
        moduleId,
        module,
        hiddenTasks,
      };
    })
    .filter((item) => item.hiddenTasks.length);
}

function renderTimelineArchivedModules() {
  const archivedModules = getTimelineArchivedModuleStats();

  if (!archivedModules.length) {
    return "";
  }

  return `
    <div class="timeline-archive-list">
      ${archivedModules
        .map(
          ({ moduleId, module, hiddenTasks }) => `
            <article class="timeline-archive-card" style="--course-accent: ${module.accent}">
              <strong>${escapeHtml(module.label)} archived after exam completion.</strong>
              <span>${hiddenTasks.length} unfinished timeline task${
                hiddenTasks.length === 1 ? "" : "s"
              } hidden.</span>
              <button type="button" data-timeline-reopen-module="${escapeHtml(moduleId)}">Reopen hidden tasks</button>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderTimelineViewContent(view) {
  const todayKey = getTodayKey();
  const tomorrowKey = addDaysToDateKey(todayKey, 1);
  const activeTasks = getTimelineActiveTasks();

  if (view === "tomorrow") {
    return renderTimelineTaskGroup(
      "Tomorrow",
      getTimelineTasksForDate(tomorrowKey),
      "The next day after today's rolling queue."
    );
  }

  if (view === "upcoming") {
    return [0, 1, 2]
      .map((offset) => {
        const dateKey = addDaysToDateKey(todayKey, offset);
        return renderTimelineTaskGroup(
          offset === 0 ? "Today" : formatSelectedDate(dateKey),
          getTimelineTasksForDate(dateKey)
        );
      })
      .join("");
  }

  if (view === "missed") {
    const missedTasks = activeTasks.filter(
      (task) => task.plannedDate < todayKey || getTimelineDelayCount(task) > 0
    );
    return renderTimelineTaskGroup(
      "Missed / rolled-over tasks",
      missedTasks,
      "Unfinished tasks that moved beyond their original planned date."
    );
  }

  if (view === "module") {
    const groups = groupTimelineTasks(activeTasks, (task) => task.moduleId);
    return Object.keys(groups)
      .sort(
        (first, second) =>
          Object.keys(TIMELINE_MODULES).indexOf(first) -
          Object.keys(TIMELINE_MODULES).indexOf(second)
      )
      .map((moduleId) =>
        renderTimelineTaskGroup(
          TIMELINE_MODULES[moduleId]?.label || moduleId,
          groups[moduleId]
        )
      )
      .join("");
  }

  if (view === "deadline") {
    const groups = groupTimelineTasks(activeTasks, (task) => task.deadline);
    return Object.keys(groups)
      .sort()
      .map((deadline) =>
        renderTimelineTaskGroup(
          `Deadline ${formatSelectedDate(deadline)}`,
          groups[deadline]
        )
      )
      .join("");
  }

  const todayTasks = getTimelineDisplayTasksForDate(todayKey);
  const nextPullTasks =
    getTimelineEnergy(todayKey) === "good"
      ? activeTasks
          .filter((task) => getTimelineEffectiveDate(task) > todayKey)
          .slice(0, 4)
      : [];

  return `
    ${renderTimelineTaskGroup(
      "Today",
      todayTasks,
      getTimelineEnergy(todayKey) === "tired"
        ? "Tired mode is protecting only critical work plus one short maintenance task."
        : "Today's rolling queue."
    )}
    ${
      nextPullTasks.length
        ? renderTimelineTaskGroup(
            "Next tasks available to pull forward",
            nextPullTasks,
            "Good energy mode shows these as extra options."
          )
        : ""
    }
  `;
}

function renderTimelinePanel() {
  const container = document.getElementById("timeline-root");

  if (!container) {
    return;
  }

  const todayKey = getTodayKey();
  const energy = getTimelineEnergy(todayKey);
  const view = uiState.timelineView || "today";
  const activeTasks = getTimelineActiveTasks();
  const todayTasks = getTimelineTasksForDate(todayKey);
  const todayMinutes = getTimelineDisplayTasksForDate(todayKey).reduce(
    (sum, task) => sum + (task.estimatedMinutes || 0),
    0
  );
  const minimumRule = getTimelineMinimumRule(todayKey);
  const viewButtons = [
    ["today", "Today"],
    ["tomorrow", "Tomorrow"],
    ["upcoming", "Upcoming 3 days"],
    ["missed", "Missed / rolled-over"],
    ["module", "By module"],
    ["deadline", "By exam deadline"],
  ];

  container.innerHTML = `
    <div class="timeline-toolbar">
      <div class="timeline-toolbar__group" aria-label="Timeline views">
        ${viewButtons
          .map(
            ([viewId, label]) => `
              <button
                type="button"
                class="${view === viewId ? "timeline-button--active" : ""}"
                data-timeline-view="${viewId}"
              >${escapeHtml(label)}</button>
            `
          )
          .join("")}
      </div>
      <div class="timeline-toolbar__group" aria-label="Energy">
        <button type="button" class="${energy === "tired" ? "timeline-button--active" : ""}" data-timeline-energy="tired">Tired day - 3h</button>
        <button type="button" class="${energy === "normal" ? "timeline-button--active" : ""}" data-timeline-energy="normal">Normal day - 4-5h</button>
        <button type="button" class="${energy === "good" ? "timeline-button--active" : ""}" data-timeline-energy="good">Good day - 6-7h</button>
      </div>
    </div>

    <div class="timeline-status-grid">
      <article>
        <span class="notes-label">Today</span>
        <strong>${escapeHtml(formatSelectedDate(todayKey))}</strong>
        <p>${todayTasks.length} active task${todayTasks.length === 1 ? "" : "s"} queued.</p>
      </article>
      <article>
        <span class="notes-label">Energy</span>
        <strong>${escapeHtml(energy.charAt(0).toUpperCase() + energy.slice(1))}</strong>
        <p>${formatTimelineDuration(todayMinutes)} shown right now.</p>
      </article>
      <article>
        <span class="notes-label">Rolling queue</span>
        <strong>${activeTasks.length}</strong>
        <p>unfinished active task${activeTasks.length === 1 ? "" : "s"} left.</p>
      </article>
    </div>

    <div class="timeline-actions">
      <button type="button" data-timeline-action="pull-next">Pull next task forward</button>
      <button type="button" data-timeline-action="move-unfinished">Move unfinished tasks to tomorrow</button>
    </div>

    <article class="timeline-minimum-card">
      <strong>${escapeHtml(minimumRule.title)}</strong>
      <p>${minimumRule.items.map((item) => escapeHtml(item)).join(" / ")}</p>
    </article>

    ${renderTimelineArchivedModules()}
    <div class="timeline-view">
      ${renderTimelineViewContent(view)}
    </div>
  `;
}

function renderDeadlineCollection(containerId, items, emptyMessage) {
  const container = document.getElementById(containerId);

  if (!container) {
    return;
  }

  if (!items.length) {
    container.innerHTML = `
      <article class="deadline-card deadline-card--empty">
        <h3>Nothing here right now</h3>
        <p class="deadline-copy">${escapeHtml(emptyMessage || "No items to show.")}</p>
      </article>
    `;
    return;
  }

  const persistenceDisabledAttribute = getPersistenceDisabledAttribute();

  const markup = items
    .map((deadline) => {
      const daysLeft = daysUntil(deadline.date);
      const isCompleted = isDeadlineItemCompleted(deadline);
      const status = isCompleted
        ? {
            label: "Completed",
            className: "deadline-pill--complete",
          }
        : deadlineStatusLabel(daysLeft);

      return `
        <article class="deadline-card ${isCompleted ? "deadline-card--completed" : ""}">
          <div class="deadline-card__top">
            <div>
              <h3>${escapeHtml(deadline.title)}</h3>
              <p class="deadline-date">${escapeHtml(deadline.dateLabel)}</p>
            </div>
            <label class="deadline-toggle">
              <input
                type="checkbox"
                data-deadline-id="${deadline.id}"
                ${isCompleted ? "checked" : ""}
                ${persistenceDisabledAttribute}
              />
              <span>Completed</span>
            </label>
          </div>
          <p class="deadline-copy">${escapeHtml(deadline.copy)}</p>
          <span class="deadline-pill ${status.className}">${escapeHtml(status.label)}</span>
        </article>
      `;
    })
    .join("");

  container.innerHTML = markup;
}

function renderCompletedArchive() {
  const container = document.getElementById("completed-item-list");

  if (!container) {
    return;
  }

  const items = getCompletedArchiveItems();

  if (!items.length) {
    container.innerHTML = `
      <article class="course-card completed-card completed-card--empty">
        <div class="course-card__top">
          <div>
            <h3>Nothing completed yet</h3>
            <p class="course-card__summary">Checked deadlines and finished exams will move here automatically.</p>
          </div>
          <div class="course-card__percent">0</div>
        </div>
      </article>
    `;
    return;
  }

  container.innerHTML = items
    .map(
      (item) => `
        <article class="course-card completed-card" style="--course-accent: ${item.accent}">
          <div class="course-card__top">
            <div>
              <h3>${escapeHtml(item.title)}</h3>
              <p class="course-card__summary">${escapeHtml(item.subtitle)}</p>
            </div>
            <div class="course-card__percent">Done</div>
          </div>
          <div class="course-meta">
            <span class="meta-pill">${escapeHtml(item.detail)}</span>
          </div>
          <p class="group-summary__note">${escapeHtml(item.note)}</p>
        </article>
      `
    )
    .join("");
}

function renderCompletedStudyPlanArchive() {
  const container = document.getElementById("completed-study-plan-list");

  if (!container) {
    return;
  }

  const items = getCompletedStudyPlanItems();
  const persistenceDisabledAttribute = getPersistenceDisabledAttribute();

  if (!items.length) {
    container.innerHTML = `
      <article class="plan-queue-card plan-queue-card--done">
        <div>
          <strong>No completed Study Plan blocks yet.</strong>
          <p class="plan-queue-card__meta">When an ordered to-do block reaches 100%, it will move here automatically.</p>
        </div>
      </article>
    `;
    return;
  }

  container.innerHTML = items
    .map((blockStat) => {
      const tagsMarkup = (blockStat.block.tags || [])
        .map((tag) => `<span class="meta-pill">${escapeHtml(tag)}</span>`)
        .join("");
      const sectionsMarkup = blockStat.block.sections
        .map((section) => {
          const tasksMarkup = section.tasks
            .map(
              (task) => `
                <label class="task-item ${task.isTaskGroupParent ? "task-item--parent" : ""} ${task.parentTaskId ? "task-item--child" : ""}">
                  <input
                    type="checkbox"
                    data-task-id="${task.id}"
                    ${getTaskCompletion(task.id) ? "checked" : ""}
                    ${persistenceDisabledAttribute}
                  />
                  <span>
                    <span class="task-title">${escapeHtml(task.title)}</span>
                    ${
                      task.caption
                        ? `<span class="task-caption">${escapeHtml(task.caption)}</span>`
                        : ""
                    }
                  </span>
                </label>
              `
            )
            .join("");

          return `
            <section class="plan-section">
              <h4 class="plan-section__title">${escapeHtml(section.label)}</h4>
              <div class="task-list">
                ${tasksMarkup}
              </div>
            </section>
          `;
        })
        .join("");

      return `
        <details
          class="plan-block completed-study-plan-card"
          data-plan-block-id="${blockStat.block.id}"
          style="--course-accent: ${blockStat.block.accent}"
        >
          <summary>
            <div class="plan-block__summary">
              <div class="plan-block__title-wrap">
                <span class="plan-order">${blockStat.block.order}</span>
                <div>
                  <h3>${escapeHtml(
                    `${blockStat.block.moduleLabel} - ${blockStat.block.title}`
                  )}</h3>
                  <p class="plan-block__subtitle">${escapeHtml(
                    `${blockStat.block.deadlineLabel} • ${blockStat.block.priority} • ${blockStat.completedTasks}/${blockStat.totalTasks} done`
                  )}</p>
                </div>
              </div>
              <div class="course-card__percent">Done</div>
            </div>
          </summary>
          <div class="group-body plan-block__body">
            <div class="course-meta">
              <span class="meta-pill">${escapeHtml(blockStat.block.moduleLabel)}</span>
              <span class="meta-pill">Deadline ${escapeHtml(
                blockStat.block.deadlineLabel
              )}</span>
              <span class="meta-pill priority-pill priority-pill--${getPlanPriorityClass(
                blockStat.block.priority
              )}">${escapeHtml(blockStat.block.priority)}</span>
              ${tagsMarkup}
            </div>
            <div class="group-progress">
              <div class="progress-track" aria-hidden="true">
                <div class="progress-fill" style="width: 100%"></div>
              </div>
            </div>
            <div class="plan-sections">
              ${sectionsMarkup}
            </div>
          </div>
        </details>
      `;
    })
    .join("");
}

function renderDeadlines(pageMode) {
  if (pageMode === "completed") {
    renderDeadlineCollection(
      "completed-deadline-list",
      getCompletedDeadlines(),
      "Completed project milestones and exams will appear here."
    );
    return;
  }

  renderDeadlineCollection(
    "deadline-list",
    getActiveProjectDeadlines(),
    "Project milestone deadlines you complete will move to the Completed tab."
  );
  renderDeadlineCollection(
    "exam-list",
    getActiveExamDeadlines(),
    "Completed exams will move to the Completed tab."
  );
}

function renderStudyLog() {
  if (
    !document.getElementById("calendar-month-label") ||
    !document.getElementById("calendar-month-summary") ||
    !document.getElementById("calendar-weekdays") ||
    !document.getElementById("calendar-grid") ||
    !document.getElementById("study-entry-card")
  ) {
    return;
  }

  const selectedEntry = getDailyEntry(uiState.selectedDate);
  const calendarDays = buildCalendarDays(uiState.calendarMonth);
  const savedDays = countEntriesInMonth(uiState.calendarMonth);
  const todayKey = getTodayKey();
  const persistenceDisabledAttribute = getPersistenceDisabledAttribute();
  const completionMarkup = selectedEntry.completedTasks.length
    ? `
      <div class="auto-log-block">
        <span class="notes-label">Completed from checkboxes</span>
        <div class="auto-log-list">
          ${selectedEntry.completedTasks
            .slice()
            .sort((first, second) => second.timestamp - first.timestamp)
            .map(
              (completion) => `
                <div class="auto-log-item">
                  <span class="auto-log-time">${escapeHtml(completion.timeLabel || "")}</span>
                  <span class="auto-log-title">${escapeHtml(completion.label)}</span>
                </div>
              `
            )
            .join("")}
        </div>
      </div>
    `
    : `
      <div class="auto-log-block">
        <span class="notes-label">Completed from checkboxes</span>
        <p class="study-entry-card__hint">Nothing auto-logged for this day yet.</p>
      </div>
    `;

  document.getElementById("calendar-month-label").textContent = formatMonthLabel(
    uiState.calendarMonth
  );
  document.getElementById("calendar-month-summary").textContent =
    `${savedDays} day${savedDays === 1 ? "" : "s"} with notes this month.`;

  document.getElementById("calendar-weekdays").innerHTML = WEEKDAY_LABELS.map(
    (label) => `<div class="calendar-weekday">${label}</div>`
  ).join("");

  document.getElementById("calendar-grid").innerHTML = calendarDays
    .map((day) => {
      const classNames = [
        "calendar-day",
        day.isOutsideMonth ? "calendar-day--outside" : "",
        day.isToday ? "calendar-day--today" : "",
        day.isSelected ? "calendar-day--selected" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const previewText = day.preview ? escapeHtml(day.preview.slice(0, 32)) : "";

      return `
        <button class="${classNames}" type="button" data-calendar-date="${day.dateKey}">
          <span class="calendar-day__number">${day.dayNumber}</span>
          ${day.hasEntry ? '<span class="calendar-dot" aria-hidden="true"></span>' : ""}
          ${
            previewText
              ? `<div class="calendar-day__note">${previewText}</div>`
              : ""
          }
        </button>
      `;
    })
    .join("");

  document.getElementById("study-entry-card").innerHTML = `
    <div>
      <p class="study-entry-card__eyebrow">Selected day</p>
      <h3 class="study-entry-card__date">${escapeHtml(formatSelectedDate(uiState.selectedDate))}</h3>
    </div>
    <div class="study-entry-card__meta">
      <span class="meta-pill">${
        uiState.selectedDate === todayKey ? "Today" : "Study log"
      }</span>
      <span class="meta-pill" data-daily-status>${
        hasDailyEntry(selectedEntry) ? "Entry saved" : "No entry yet"
      }</span>
    </div>
    <p class="study-entry-card__hint">
      Use this to record what you finished and what you want your future self to pick up next.
    </p>
    ${completionMarkup}
    <label class="notes-block">
      <span class="notes-label">What I did</span>
      <textarea
        class="notes-input study-entry-input"
        data-daily-field="done"
        data-daily-date="${uiState.selectedDate}"
        placeholder="Problem sheets, project writing, revision, quiz prep..."
        ${persistenceDisabledAttribute}
      >${escapeHtml(selectedEntry.done || "")}</textarea>
    </label>
    <label class="notes-block">
      <span class="notes-label">Reminder for next time</span>
      <textarea
        class="notes-input study-entry-input"
        data-daily-field="reminder"
        data-daily-date="${uiState.selectedDate}"
        placeholder="Leave the next step, question, or reminder here..."
        ${persistenceDisabledAttribute}
      >${escapeHtml(selectedEntry.reminder || "")}</textarea>
    </label>
  `;
}

function refreshStudyLogIndicators(dateKey) {
  const entry = getDailyEntry(dateKey);
  const entryExists = hasDailyEntry(entry);
  const status = document.querySelector("[data-daily-status]");
  const monthSummary = document.getElementById("calendar-month-summary");
  const dayButton = document.querySelector(`button[data-calendar-date="${dateKey}"]`);

  if (status) {
    status.textContent = entryExists ? "Entry saved" : "No entry yet";
  }

  if (monthSummary) {
    const savedDays = countEntriesInMonth(uiState.calendarMonth);
    monthSummary.textContent =
      `${savedDays} day${savedDays === 1 ? "" : "s"} with notes this month.`;
  }

  if (!dayButton) {
    return;
  }

  const existingDot = dayButton.querySelector(".calendar-dot");
  const existingPreview = dayButton.querySelector(".calendar-day__note");
  const previewText = getDailyPreview(entry).slice(0, 32);

  if (entryExists && !existingDot) {
    dayButton.insertAdjacentHTML(
      "beforeend",
      '<span class="calendar-dot" aria-hidden="true"></span>'
    );
  }

  if (!entryExists && existingDot) {
    existingDot.remove();
  }

  if (previewText) {
    const preview = existingPreview || document.createElement("div");
    preview.className = "calendar-day__note";
    preview.textContent = previewText;

    if (!existingPreview) {
      dayButton.appendChild(preview);
    }
  } else if (existingPreview) {
    existingPreview.remove();
  }
}

function renderSimplePastPaperEntries(group, persistenceDisabledAttribute) {
  const labels = group.sectionLabels || { a: "Part A", b: "Part B" };

  return `
    <div class="paper-entry-list">
      ${(group.paperEntries || [])
        .map((entry, index) => {
          const partAId = `${entry.id}-part-a`;
          const partBId = `${entry.id}-part-b`;
          const noteKey = `paper-note-${entry.id}`;

          return `
            <article class="paper-entry">
              <div class="paper-entry__top">
                <div>
                  <h5>${escapeHtml(`${index + 1}. ${entry.title}`)}</h5>
                  ${entry.file ? `<p class="paper-entry__file">${escapeHtml(entry.file)}</p>` : ""}
                </div>
              </div>
              ${
                entry.whyNow
                  ? `<p class="paper-entry__why"><strong>Why now:</strong> ${escapeHtml(entry.whyNow)}</p>`
                  : ""
              }
              ${
                entry.skipNotes
                  ? `<p class="paper-entry__skip"><strong>Skip / selective notes:</strong> ${escapeHtml(entry.skipNotes)}</p>`
                  : ""
              }
              <div class="paper-entry__checks">
                <label class="task-item">
                  <input
                    type="checkbox"
                    data-task-id="${partAId}"
                    ${getTaskCompletion(partAId) ? "checked" : ""}
                    ${persistenceDisabledAttribute}
                  />
                  <span>
                    <span class="task-title">${escapeHtml(labels.a)}</span>
                    ${
                      entry.partAFocus || entry.sectionAFocus
                        ? `<span class="task-caption">${escapeHtml(entry.partAFocus || entry.sectionAFocus)}</span>`
                        : ""
                    }
                  </span>
                </label>
                <label class="task-item">
                  <input
                    type="checkbox"
                    data-task-id="${partBId}"
                    ${getTaskCompletion(partBId) ? "checked" : ""}
                    ${persistenceDisabledAttribute}
                  />
                  <span>
                    <span class="task-title">${escapeHtml(labels.b)}</span>
                    ${
                      entry.partBFocus || entry.sectionBFocus
                        ? `<span class="task-caption">${escapeHtml(entry.partBFocus || entry.sectionBFocus)}</span>`
                        : ""
                    }
                  </span>
                </label>
              </div>
              <label class="notes-block paper-entry__notes">
                <span class="notes-label">Optional notes</span>
                <textarea
                  class="notes-input"
                  data-course-note="${noteKey}"
                  placeholder="Short focus line, mistakes, or what to revisit..."
                  ${persistenceDisabledAttribute}
                >${escapeHtml(state.notes[noteKey] || "")}</textarea>
              </label>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderPastPaperCard(courseStat) {
  const persistenceDisabledAttribute = getPersistenceDisabledAttribute();

  if (courseStat.totalTaskCount === 0) {
    return `
      <article class="course-card past-paper-card" style="--course-accent: ${courseStat.course.accent}">
        <div class="course-card__top">
          <div>
            <h3>${escapeHtml(courseStat.course.title)}</h3>
            <p class="past-paper-card__summary">No past papers added yet for this module.</p>
          </div>
          <div class="course-card__percent">0 papers</div>
        </div>

        <div class="course-meta">
          <span class="meta-pill">Update when papers are available</span>
        </div>

        <div class="group">
          <div class="group-body">
            <p class="group-summary__note">${escapeHtml(
              courseStat.groupStats[0]?.group.note || "No past papers added yet."
            )}</p>
          </div>
        </div>
      </article>
    `;
  }

  const groupsMarkup = courseStat.groupStats
    .map((groupStat) => {
      const tasksMarkup = groupStat.group.paperEntries
        ? renderSimplePastPaperEntries(groupStat.group, persistenceDisabledAttribute)
        : groupStat.group.tasks
            .map(
              (task) => `
                <label class="task-item ${task.isTaskGroupParent ? "task-item--parent" : ""} ${task.parentTaskId ? "task-item--child" : ""}">
                  <input
                    type="checkbox"
                    data-task-id="${task.id}"
                    ${getTaskCompletion(task.id) ? "checked" : ""}
                    ${persistenceDisabledAttribute}
                  />
                  <span>
                    <span class="task-title">${escapeHtml(task.title)}</span>
                    ${
                      task.caption
                        ? `<span class="task-caption">${escapeHtml(task.caption)}</span>`
                        : ""
                    }
                  </span>
                </label>
              `
            )
            .join("");

      return `
        <div class="group">
          <div class="group-body">
            <div class="group-progress">
              <div class="progress-track" aria-hidden="true">
                <div
                  class="progress-fill"
                  style="--course-accent: ${courseStat.course.accent}; width: ${Math.round(
                    groupStat.ratio * 100
                  )}%"
                ></div>
              </div>
            </div>
            <h4 class="past-paper-card__section-title">${escapeHtml(groupStat.group.title)}</h4>
            <p class="group-summary__note">${escapeHtml(groupStat.group.note || "")}</p>
            <div class="${groupStat.group.paperEntries ? "" : "task-list"}">
              ${tasksMarkup}
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <article class="course-card past-paper-card" style="--course-accent: ${courseStat.course.accent}">
      <div class="course-card__top">
        <div>
          <h3>${escapeHtml(courseStat.course.title)}</h3>
          <p class="past-paper-card__summary">Past paper progress stays synced anywhere the same papers appear.</p>
        </div>
        <div class="course-card__percent">${courseStat.percent}%</div>
      </div>

      <div class="progress-track" aria-hidden="true">
        <div class="progress-fill" style="width: ${courseStat.percent}%"></div>
      </div>

      <div class="course-meta">
        <span class="meta-pill">${courseStat.completedTaskCount}/${courseStat.totalTaskCount} done</span>
      </div>

      ${groupsMarkup}
    </article>
  `;
}

function renderCourseCard(course, stats, openGroups, pageMode) {
  const persistenceDisabledAttribute = getPersistenceDisabledAttribute();
  const metaMarkup = course.meta
    .map((item) => `<span class="meta-pill">${escapeHtml(item)}</span>`)
    .join("");

  const visibleGroupStats =
    pageMode === "courses"
      ? stats.groupStats.filter(
          (groupStat) => !isGroupCompletedByDeadline(groupStat.group.id)
        )
      : stats.groupStats;

  const groupsMarkup = visibleGroupStats
    .map((groupStat) => {
      const isOpen = openGroups.has(groupStat.group.id) ? "open" : "";
      const dueMarkup = groupStat.group.optional
        ? '<span class="meta-pill">Optional</span>'
        : groupStat.group.dueLabel
          ? `<span class="meta-pill">Due ${escapeHtml(groupStat.group.dueLabel)}</span>`
          : `<span class="meta-pill">${formatWeightLabel(groupStat.group.weight)}% weight</span>`;

      const tasksMarkup = groupStat.group.tasks
        .map(
          (task) => `
            <label class="task-item ${task.isTaskGroupParent ? "task-item--parent" : ""} ${task.parentTaskId ? "task-item--child" : ""}">
              <input
                type="checkbox"
                data-task-id="${task.id}"
                ${getTaskCompletion(task.id) ? "checked" : ""}
                ${persistenceDisabledAttribute}
              />
              <span>
                <span class="task-title">${escapeHtml(task.title)}</span>
                ${
                  task.caption
                    ? `<span class="task-caption">${escapeHtml(task.caption)}</span>`
                    : ""
                }
              </span>
            </label>
          `
        )
        .join("");

      return `
        <details class="group" data-group-id="${groupStat.group.id}" ${isOpen}>
          <summary>
            <div class="group-summary">
              <div>
                <h4>${escapeHtml(groupStat.group.title)}</h4>
                <p class="group-summary__note">${escapeHtml(groupStat.group.note || "")}</p>
              </div>
              <div class="group-summary__meta">
                ${dueMarkup}
                <span class="meta-pill">${groupStat.completedTasks}/${groupStat.totalTasks} done</span>
              </div>
            </div>
          </summary>
          <div class="group-body">
            <div class="group-progress">
              <div class="progress-track" aria-hidden="true">
                <div
                  class="progress-fill"
                  style="--course-accent: ${course.accent}; width: ${Math.round(
                    groupStat.ratio * 100
                  )}%"
                ></div>
              </div>
            </div>
            <div class="task-list">
              ${tasksMarkup}
            </div>
          </div>
        </details>
      `;
    })
    .join("");

  return `
    <article class="course-card" style="--course-accent: ${course.accent}">
      <div class="course-card__top">
        <div>
          <h3>${escapeHtml(course.title)}</h3>
          <p class="course-card__summary">${escapeHtml(course.summary)}</p>
        </div>
        <div class="course-card__percent">${stats.percent}%</div>
      </div>

      <div class="progress-track" aria-hidden="true">
        <div class="progress-fill" style="width: ${stats.percent}%"></div>
      </div>

      <div class="course-meta">${metaMarkup}</div>

      <div class="group-list">
        ${groupsMarkup}
      </div>

      <label class="notes-block">
        <span class="notes-label">This week's focus</span>
        <textarea
          class="notes-input"
          data-course-note="${course.id}"
          placeholder="Add a short note, reminder, or next action..."
          ${persistenceDisabledAttribute}
        >${escapeHtml(state.notes[course.id] || "")}</textarea>
      </label>
    </article>
  `;
}

function getPlanPriorityClass(priority) {
  return priority.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function getTaskIdsForBulkToggle(tasks) {
  return tasks.map((task) => task.id).filter(Boolean);
}

function getBulkToggleState(taskIds) {
  const completedCount = taskIds.filter((taskId) => getTaskCompletion(taskId)).length;

  return {
    completedCount,
    totalCount: taskIds.length,
    checked: Boolean(taskIds.length) && completedCount === taskIds.length,
    partial: completedCount > 0 && completedCount < taskIds.length,
  };
}

function renderBulkToggle(taskIds, label, className = "") {
  const state = getBulkToggleState(taskIds);
  const encodedIds = taskIds.map(escapeHtml).join(",");

  return `
    <label class="bulk-check ${className}">
      <input
        type="checkbox"
        data-bulk-task-ids="${encodedIds}"
        data-bulk-partial="${state.partial ? "true" : "false"}"
        aria-label="${escapeHtml(label)}"
        ${state.checked ? "checked" : ""}
        ${taskIds.length ? "" : "disabled"}
        ${getPersistenceDisabledAttribute()}
      />
      <span>${escapeHtml(label)}</span>
    </label>
  `;
}

function renderStudyPlanQueue(summary) {
  const container = document.getElementById("plan-queue");

  if (!container) {
    return;
  }

  const upcomingBlocks = summary.nextBlocks.slice(0, 6);

  if (!upcomingBlocks.length) {
    container.innerHTML = `
      <article class="plan-queue-card plan-queue-card--done">
        <div>
          <strong>Everything in the ordered plan is checked off.</strong>
          <p class="plan-queue-card__meta">Use this page as a final sweep and confidence check.</p>
        </div>
      </article>
    `;
    return;
  }

  container.innerHTML = upcomingBlocks
    .map(
      (blockStat) => `
        <article class="plan-queue-card" style="--course-accent: ${blockStat.block.accent}">
          <div class="plan-queue-card__top">
            <div class="plan-queue-card__title-wrap">
              <span class="plan-order">${blockStat.block.order}</span>
              <div>
                <strong>${escapeHtml(
                  `${blockStat.block.shortModule} - ${blockStat.block.title}`
                )}</strong>
                <p class="plan-queue-card__meta">${escapeHtml(
                  `${blockStat.block.deadlineLabel} • ${blockStat.block.priority} • ${blockStat.completedTasks}/${blockStat.totalTasks} done`
                )}</p>
                ${
                  blockStat.block.sourceFile && blockStat.block.question
                    ? `<p class="plan-queue-card__meta plan-queue-card__meta--secondary">${escapeHtml(
                        `${blockStat.block.sourceFile} • ${blockStat.block.question}`
                      )}</p>`
                    : ""
                }
              </div>
            </div>
            <span class="hero-course-percent">${blockStat.percent}%</span>
          </div>
          <div class="progress-track" aria-hidden="true">
            <div class="progress-fill" style="width: ${blockStat.percent}%"></div>
          </div>
        </article>
      `
    )
    .join("");
}

function renderStudyPlanSummaries(summary) {
  const deadlineContainer = document.getElementById("plan-deadline-summary");
  const criticalContainer = document.getElementById("plan-critical-summary");

  if (deadlineContainer) {
    deadlineContainer.innerHTML = summary.deadlineStats
      .map(
        (deadlineStat) => `
          <article class="deadline-card">
            <h3>${escapeHtml(deadlineStat.deadlineLabel)}</h3>
            <p class="deadline-copy">${deadlineStat.completedTasks}/${deadlineStat.totalTasks} tasks done</p>
            <div class="progress-track" aria-hidden="true">
              <div class="progress-fill" style="width: ${deadlineStat.percent}%"></div>
            </div>
            <span class="deadline-pill deadline-pill--safe">${deadlineStat.percent}% complete</span>
          </article>
        `
      )
      .join("");
  }

  if (criticalContainer) {
    const missedMarkup = summary.missedCriticalBlocks.length
      ? `
        <div class="plan-missed-list">
          ${summary.missedCriticalBlocks
            .map(
              (blockStat) => `
                <div class="plan-missed-item">
                  <strong>${escapeHtml(
                    `${blockStat.block.order}. ${blockStat.block.shortModule} - ${blockStat.block.title}`
                  )}</strong>
                  <p>${escapeHtml(
                    `${blockStat.completedTasks}/${blockStat.totalTasks} tasks done • deadline ${blockStat.block.deadlineLabel}`
                  )}</p>
                </div>
              `
            )
            .join("")}
        </div>
      `
      : '<p class="group-summary__note">No overdue critical blocks right now.</p>';

    criticalContainer.innerHTML = `
      <article class="plan-critical-card">
        <div class="course-card__top">
          <div>
            <h3>Critical-task completion</h3>
            <p class="course-card__summary">${summary.criticalCompletedTasks}/${summary.criticalTotalTasks} critical checklist items finished.</p>
          </div>
          <div class="course-card__percent">${summary.criticalTaskPercent}%</div>
        </div>
        <div class="progress-track" aria-hidden="true">
          <div class="progress-fill" style="width: ${summary.criticalTaskPercent}%"></div>
        </div>
        <div class="course-meta">
          <span class="meta-pill">${summary.missedCriticalBlocks.length} missed critical blocks</span>
        </div>
        ${missedMarkup}
      </article>
    `;
  }
}

function renderStudyPlanPage(summary, openPlanBlocks) {
  const container = document.getElementById("master-plan-phase-list");

  if (!container) {
    return;
  }

  const persistenceDisabledAttribute = getPersistenceDisabledAttribute();
  const defaultOpenIds = new Set(
    summary.nextBlocks.slice(0, 3).map((blockStat) => blockStat.block.id)
  );

  container.innerHTML = summary.phaseStats
    .map((phaseStat) => {
      const activeBlockStats = phaseStat.blockStats.filter(
        (blockStat) => blockStat.completedTasks < blockStat.totalTasks
      );
      const descriptionMarkup = phaseStat.phase.description
        ? `<p class="plan-phase__summary">${escapeHtml(phaseStat.phase.description)}</p>`
        : "";
      const blocksMarkup = activeBlockStats
        .map((blockStat) => {
          const isOpen =
            openPlanBlocks.has(blockStat.block.id) ||
            (!openPlanBlocks.size && defaultOpenIds.has(blockStat.block.id))
              ? "open"
              : "";
          const tagsMarkup = (blockStat.block.tags || [])
            .map((tag) => `<span class="meta-pill">${escapeHtml(tag)}</span>`)
            .join("");
          const sectionsMarkup = blockStat.block.sections
            .map((section) => {
              const sectionTaskIds = getTaskIdsForBulkToggle(section.tasks);
              const tasksMarkup = section.tasks
                .map(
                  (task) => `
                    <label class="task-item ${task.isTaskGroupParent ? "task-item--parent" : ""} ${task.parentTaskId ? "task-item--child" : ""}">
                      <input
                        type="checkbox"
                        data-task-id="${task.id}"
                        ${getTaskCompletion(task.id) ? "checked" : ""}
                        ${persistenceDisabledAttribute}
                      />
                      <span>
                        <span class="task-title">${escapeHtml(task.title)}</span>
                        ${
                          task.caption
                            ? `<span class="task-caption">${escapeHtml(task.caption)}</span>`
                            : ""
                        }
                      </span>
                    </label>
                  `
                )
                .join("");

              return `
                <section class="plan-section">
                  <div class="plan-section__heading">
                    <h4 class="plan-section__title">${escapeHtml(section.label)}</h4>
                    ${renderBulkToggle(
                      sectionTaskIds,
                      `Check all ${section.label}`,
                      "bulk-check--section"
                    )}
                  </div>
                  <div class="task-list">
                    ${tasksMarkup}
                  </div>
                </section>
              `;
            })
            .join("");
          const blockTaskIds = getTaskIdsForBulkToggle(blockStat.block.tasks);

          return `
            <details
              class="plan-block"
              data-plan-block-id="${blockStat.block.id}"
              style="--course-accent: ${blockStat.block.accent}"
              ${isOpen}
            >
              <summary>
                <div class="plan-block__summary">
                  <div class="plan-block__title-wrap">
                    <span class="plan-order">${blockStat.block.order}</span>
                    <div>
                      <div class="plan-block__headline">
                        <h3>${escapeHtml(
                          `${blockStat.block.moduleLabel} - ${blockStat.block.title}`
                        )}</h3>
                        ${renderBulkToggle(
                          blockTaskIds,
                          `Check all ${blockStat.block.moduleLabel} - ${blockStat.block.title}`,
                          "bulk-check--block"
                        )}
                      </div>
                      <p class="plan-block__subtitle">${escapeHtml(
                        `${blockStat.block.deadlineLabel} • ${blockStat.block.priority}${
                          blockStat.block.type ? ` • ${blockStat.block.type}` : ""
                        }`
                      )}</p>
                    </div>
                  </div>
                  <div class="course-card__percent">${blockStat.percent}%</div>
                </div>
              </summary>
              <div class="group-body plan-block__body">
                <div class="course-meta">
                  <span class="meta-pill">${escapeHtml(blockStat.block.moduleLabel)}</span>
                  <span class="meta-pill">Deadline ${escapeHtml(
                    blockStat.block.deadlineLabel
                  )}</span>
                  <span class="meta-pill priority-pill priority-pill--${getPlanPriorityClass(
                    blockStat.block.priority
                  )}">${escapeHtml(blockStat.block.priority)}</span>
                  ${
                    blockStat.block.type
                      ? `<span class="meta-pill">${escapeHtml(blockStat.block.type)}</span>`
                      : ""
                  }
                  ${
                    blockStat.block.status
                      ? `<span class="meta-pill">${escapeHtml(blockStat.block.status)}</span>`
                      : ""
                  }
                  ${tagsMarkup}
                  <span class="meta-pill">${blockStat.completedTasks}/${blockStat.totalTasks} done</span>
                </div>
                ${
                  blockStat.block.reason
                    ? `<div class="plan-reason-box"><strong>Why this matters</strong><p>${escapeHtml(
                        blockStat.block.reason
                      )}</p></div>`
                    : ""
                }
                <div class="group-progress">
                  <div class="progress-track" aria-hidden="true">
                    <div class="progress-fill" style="width: ${blockStat.percent}%"></div>
                  </div>
                </div>
                <div class="plan-sections">
                  ${sectionsMarkup}
                </div>
              </div>
            </details>
          `;
        })
        .join("");
      const emptyMarkup = activeBlockStats.length
        ? ""
        : `
          <article class="plan-queue-card plan-queue-card--done">
            <div>
              <strong>Everything in this study section is already done.</strong>
              <p class="plan-queue-card__meta">Completed 100% blocks are hidden from the active to-do list to keep the page cleaner.</p>
            </div>
          </article>
        `;

      return `
        <section class="plan-phase">
          <div class="plan-phase__header">
            <div>
              <div class="plan-phase__headline">
                <h2 class="plan-phase__title">${escapeHtml(phaseStat.phase.title)}</h2>
                ${renderBulkToggle(
                  getTaskIdsForBulkToggle(
                    phaseStat.blockStats.flatMap((blockStat) => blockStat.block.tasks)
                  ),
                  `Check all ${phaseStat.phase.title}`,
                  "bulk-check--phase"
                )}
              </div>
              ${descriptionMarkup}
            </div>
            <div class="plan-phase__meta">
              <span class="meta-pill">${phaseStat.percent}% complete</span>
              <span class="meta-pill">${phaseStat.completedTasks}/${phaseStat.totalTasks} tasks done</span>
            </div>
          </div>
          <div class="plan-block-list">
            ${blocksMarkup || emptyMarkup}
          </div>
        </section>
      `;
    })
    .join("");
}

function renderHeroCourseList(courseStats) {
  const container = document.getElementById("hero-course-list");

  if (!container) {
    return;
  }

  const markup = courseStats
    .map(
      (courseStat) => `
        <div class="hero-course-row" style="--course-accent: ${courseStat.course.accent}">
          <div class="hero-course-row__top">
            <span class="hero-course-name">${escapeHtml(courseStat.course.title)}</span>
            <span class="hero-course-percent">${courseStat.percent}%</span>
          </div>
          <div class="progress-track" aria-hidden="true">
            <div class="progress-fill" style="width: ${courseStat.percent}%"></div>
          </div>
          <div class="hero-course-meta">
            ${courseStat.completedTaskCount}/${courseStat.totalTaskCount} tracked items completed
          </div>
        </div>
      `
    )
    .join("");

  container.innerHTML = markup;
}

function renderOverview(summary, pageMode) {
  const todayDate = document.getElementById("today-date");
  const overallPercent = document.getElementById("overall-percent");
  const overallFill = document.getElementById("overall-progress-fill");
  const overallSummary = document.getElementById("overall-summary");
  const overviewTitle = document.getElementById("overview-title");

  if (!todayDate || !overallPercent || !overallFill || !overallSummary || !overviewTitle) {
    return;
  }

  const label =
    pageMode === "past-papers"
      ? "Past Paper Progress"
      : pageMode === "study-plan"
        ? "Master Study Plan"
      : pageMode === "completed"
        ? "Completed"
        : "Overall Progress";
  const scopeLabel =
    pageMode === "past-papers"
      ? `${summary.courseStats.length} modules`
      : pageMode === "study-plan"
        ? `${summary.blockStats.length} ordered blocks`
      : pageMode === "completed"
        ? `${summary.completedTasks} archived items`
        : `${summary.courseStats.length} courses`;

  todayDate.textContent = formatToday();
  overallPercent.textContent = `${summary.average}%`;
  overallFill.style.width = `${summary.average}%`;
  overallSummary.textContent =
    pageMode === "completed"
      ? `${summary.completedTasks} of ${summary.totalTasks} completed items are now in the completed tab.`
      : pageMode === "study-plan"
        ? `${summary.completedTasks} of ${summary.totalTasks} study tasks completed across ${scopeLabel}.`
      : `${summary.completedTasks} of ${summary.totalTasks} tracked items completed across ${scopeLabel}.`;
  overviewTitle.textContent = label;
}

function getOpenGroups() {
  return new Set(
    Array.from(document.querySelectorAll("details.group[open]")).map((detail) =>
      detail.getAttribute("data-group-id")
    )
  );
}

function getOpenPlanBlocks() {
  return new Set(
    Array.from(document.querySelectorAll("details.plan-block[open]")).map((detail) =>
      detail.getAttribute("data-plan-block-id")
    )
  );
}

function renderDashboard() {
  const pageMode = document.body.dataset.page || "courses";
  const overall = calculateOverallProgress();
  const pastPaperStats = courses
    .filter((course) => !isCourseExamCompleted(course.id))
    .map((course) => calculatePastPaperProgress(course))
    .filter(Boolean);
  const pastPaperOverview = calculatePastPaperOverview(pastPaperStats);
  const completedOverview = calculateCompletedOverview();
  const masterPlanOverview = calculateMasterPlanProgress();
  const openGroups = getOpenGroups();
  const openPlanBlocks = getOpenPlanBlocks();
  const activeSummary =
    pageMode === "past-papers"
      ? pastPaperOverview
      : pageMode === "study-plan"
        ? masterPlanOverview
      : pageMode === "completed"
        ? completedOverview
        : overall;
  const activeHeroStats =
    pageMode === "past-papers"
      ? pastPaperOverview.courseStats
      : pageMode === "completed"
        ? completedOverview.courseStats
        : overall.courseStats;
  const coursesGrid = document.getElementById("courses-grid");
  const pastPaperList = document.getElementById("past-paper-list");
  const completedItemList = document.getElementById("completed-item-list");

  renderStorageBanner();
  renderOverview(activeSummary, pageMode);
  renderHeroCourseList(activeHeroStats);
  renderStudyPlanQueue(masterPlanOverview);
  renderStudyPlanSummaries(masterPlanOverview);
  renderStudyPlanPage(masterPlanOverview, openPlanBlocks);
  renderTimelinePanel();

  if (coursesGrid) {
    coursesGrid.innerHTML = overall.courseStats
      .map((courseStat) =>
        renderCourseCard(courseStat.course, courseStat, openGroups, pageMode)
      )
      .join("");
  }

  if (pastPaperList) {
    pastPaperList.innerHTML = pastPaperStats
      .map((courseStat) => renderPastPaperCard(courseStat))
      .join("");
  }

  if (completedItemList) {
    renderCompletedArchive();
  }

  renderCompletedStudyPlanArchive();

  renderDeadlines(pageMode);
  renderStudyLog();
  bindInteractions();
}

function bindInteractions() {
  document.querySelectorAll("input[type='checkbox'][data-deadline-id]").forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      setDeadlineCompletion(event.target.dataset.deadlineId, event.target.checked);
      renderDashboard();
    });
  });

  document.querySelectorAll("input[type='checkbox'][data-task-id]").forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      setTaskCompletion(event.target.dataset.taskId, event.target.checked);
      renderDashboard();
    });
  });

  document.querySelectorAll(".bulk-check").forEach((label) => {
    label.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  });

  document.querySelectorAll("input[type='checkbox'][data-bulk-task-ids]").forEach((checkbox) => {
    checkbox.indeterminate = checkbox.dataset.bulkPartial === "true";
    checkbox.addEventListener("change", (event) => {
      const taskIds = event.target.dataset.bulkTaskIds
        .split(",")
        .map((taskId) => taskId.trim())
        .filter(Boolean);

      setBulkTaskCompletion(taskIds, event.target.checked);
      renderDashboard();
    });
  });

  document.querySelectorAll("button[data-timeline-view]").forEach((button) => {
    button.addEventListener("click", (event) => {
      uiState.timelineView = event.currentTarget.dataset.timelineView;
      renderDashboard();
    });
  });

  document.querySelectorAll("button[data-timeline-energy]").forEach((button) => {
    button.addEventListener("click", (event) => {
      const energy = event.currentTarget.dataset.timelineEnergy;

      if (energy === "tired") {
        markTimelineDayTired();
      } else if (energy === "good") {
        markTimelineDayGood();
      } else {
        setTimelineEnergy(getTodayKey(), "normal");
      }

      renderDashboard();
    });
  });

  document.querySelectorAll("button[data-timeline-action]").forEach((button) => {
    button.addEventListener("click", (event) => {
      const action = event.currentTarget.dataset.timelineAction;

      if (action === "pull-next") {
        pullNextTimelineTaskForward();
      }

      if (action === "move-unfinished") {
        moveUnfinishedTimelineTasksToTomorrow();
      }

      renderDashboard();
    });
  });

  document.querySelectorAll("button[data-timeline-move-task]").forEach((button) => {
    button.addEventListener("click", (event) => {
      moveTimelineTaskToTomorrow(event.currentTarget.dataset.timelineMoveTask);
      renderDashboard();
    });
  });

  document.querySelectorAll("button[data-timeline-skip-task]").forEach((button) => {
    button.addEventListener("click", (event) => {
      markTimelineTaskSkipped(event.currentTarget.dataset.timelineSkipTask);
      renderDashboard();
    });
  });

  document.querySelectorAll("button[data-timeline-reopen-module]").forEach((button) => {
    button.addEventListener("click", (event) => {
      reopenTimelineModule(event.currentTarget.dataset.timelineReopenModule);
      renderDashboard();
    });
  });

  document.querySelectorAll("textarea[data-course-note]").forEach((textarea) => {
    textarea.addEventListener("input", (event) => {
      setCourseNote(event.target.dataset.courseNote, event.target.value);
    });
  });

  document.querySelectorAll("button[data-calendar-date]").forEach((button) => {
    button.addEventListener("click", (event) => {
      uiState.selectedDate = event.currentTarget.dataset.calendarDate;
      uiState.calendarMonth = uiState.selectedDate.slice(0, 7);
      renderDashboard();
    });
  });

  document.querySelectorAll("button[data-calendar-nav]").forEach((button) => {
    if (button.dataset.calendarNavBound === "true") {
      return;
    }

    button.dataset.calendarNavBound = "true";
    button.addEventListener("click", (event) => {
      const direction = event.currentTarget.dataset.calendarNav === "next" ? 1 : -1;
      uiState.calendarMonth = shiftMonth(uiState.calendarMonth, direction);
      uiState.selectedDate = `${uiState.calendarMonth}-01`;
      renderDashboard();
    });
  });

  document.querySelectorAll("textarea[data-daily-field]").forEach((textarea) => {
    textarea.addEventListener("input", (event) => {
      const dateKey = event.target.dataset.dailyDate;
      setDailyEntry(dateKey, event.target.dataset.dailyField, event.target.value);
      refreshStudyLogIndicators(dateKey);
    });
  });
}

function overwriteState(nextState) {
  const normalized = normalizeState(nextState);

  state.tasks = normalized.tasks;
  state.notes = normalized.notes;
  state.dailyLog = normalized.dailyLog;
  state.deadlines = normalized.deadlines;
  state.timeline = normalized.timeline;
  state.updatedAt = normalized.updatedAt;
}

async function initializeApp() {
  setStorageStatus("loading");

  try {
    const serverState = await loadServerState();
    serverSyncAvailable = true;
    serverSyncRetryAfter = 0;
    const recoveredLegacyTasks = migrateLegacyTaskState(serverState);

    storageUiState.recoveredLegacyTasks = recoveredLegacyTasks;
    overwriteState(serverState);
    setStorageStatus("file");

    if (recoveredLegacyTasks) {
      scheduleServerSave(cloneStateSnapshot(), true);
    }
  } catch (error) {
    serverSyncAvailable = false;
    serverSyncRetryAfter = Date.now() + STORAGE_RETRY_DELAY_MS;
    storageUiState.recoveredLegacyTasks = 0;
    overwriteState(createEmptyState());
    setStorageStatus("unavailable");
  }

  renderDashboard();
}

const state = createEmptyState();
const uiState = {
  selectedDate: getTodayKey(),
  calendarMonth: getTodayKey().slice(0, 7),
  timelineView: "today",
};
void initializeApp();
