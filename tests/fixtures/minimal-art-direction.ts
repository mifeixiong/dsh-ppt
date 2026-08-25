export const MINIMAL_ART_DIRECTION = {
  version: 1,
  concept: 'Editorial clarity',
  audience_effect: 'Confident, focused, and visually paced',
  palette: {
    background: ['#F7F5F0', '#111318'],
    surface: ['#FFFFFF'],
    accent: '#2563EB',
    text: ['#111318', '#FFFFFF'],
  },
  typography: {
    display: { family: 'Liter', weight: 700 },
    body: { family: 'Liter', weight: 400 },
    latin: { family: 'Liter', weight: 500 },
    code: { family: 'Liter', weight: 400 },
  },
  rhythm: {
    background_sequence: ['base'],
    max_grouped_frame_slides: 0,
    max_same_composition_run: 1,
  },
  slides: [{
    page: 1,
    job: 'Establish the central claim',
    takeaway: 'A directed deck makes design intent testable',
    composition: 'hero',
    density: 'low',
    background_role: 'base',
    title_treatment: 'statement',
    visual_anchor: { kind: 'typography', role: 'Make the claim dominant', min_area_ratio: 0.2 },
    frame_policy: 'none',
    allow_intentional_repeat: false,
  }],
} as const
