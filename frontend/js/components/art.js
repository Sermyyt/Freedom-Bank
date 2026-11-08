// Собственные иллюстрации CQA: встроенный SVG, цвета задаются классами в CSS. Декоративные — скрыты от скринридера.
import { svgTree } from '../dom.js';

const hidden = { 'aria-hidden': 'true', focusable: 'false' };

function art(viewBox, className, ...children) {
  return svgTree(['svg', { viewBox, class: `cqa-art ${className}`, ...hidden }, ...children]);
}

// Пузырь переписки: подложка и строки текста; строка с marked получает маркер доказательства под собой.
function bubble(x, y, w, h, tone, lines) {
  return ['g', {},
    ['rect', { x, y, width: w, height: h, rx: Math.min(18, h / 2), class: `cqa-art-bubble cqa-art-bubble--${tone}` }],
    ...lines.flatMap(([dx, dy, lw, cls = 'line', marked = false]) => [
      marked ? ['rect', { x: x + dx - 6, y: y + dy - 5, width: lw + 12, height: 17, rx: 6, class: 'cqa-art-marker' }] : null,
      ['rect', { x: x + dx, y: y + dy, width: lw, height: 7, rx: 3.5, class: `cqa-art-${cls}` }],
    ]),
  ];
}

// Штриховка «клиент не слышит»: у каждой иллюстрации свой id, чтобы не конфликтовать на одной странице.
function hatch(id) {
  return ['defs', {},
    ['pattern', { id, width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
      ['rect', { width: 3, height: 8, class: 'cqa-art-hatch-line' }]],
  ];
}

function muteIcon(cx, cy) {
  return ['g', { class: 'cqa-art-mute' },
    ['circle', { cx, cy, r: 13, class: 'cqa-art-mute-bg' }],
    ['path', { d: `M${cx - 6} ${cy - 3}h3l4-4v14l-4-4h-3z`, class: 'cqa-art-mute-glyph' }],
    ['path', { d: `M${cx + 3} ${cy - 4}l6 8M${cx + 9} ${cy - 4}l-6 8`, class: 'cqa-art-mute-cross' }],
  ];
}

function check(cx, cy, size = 1) {
  return ['path', { d: `M${cx - 9 * size} ${cy}l${6 * size} ${6 * size} ${12 * size} -${13 * size}`, class: 'cqa-art-check' }];
}

export function brandMark() {
  return svgTree(['svg', { viewBox: '0 0 32 32', class: 'cqa-brand-mark', ...hidden },
    ['rect', { width: 32, height: 32, rx: 9, class: 'cqa-brand-mark-bg' }],
    ['path', { d: 'M9 9.5h14a3 3 0 0 1 3 3v6.5a3 3 0 0 1-3 3h-7.5L11 25.5V22H9a3 3 0 0 1-3-3v-6.5a3 3 0 0 1 3-3z', class: 'cqa-brand-mark-bubble' }],
    ['path', { d: 'M11.8 15.9l2.7 2.6 5.4-5.6', class: 'cqa-brand-mark-check' }],
  ]);
}

// Обложка: пузыри переписки, полоса «клиент не слышит», круговой индикатор и связь доказательства с ним.
// Внешняя группа отвечает за появление, внутренняя — за «дыхание», поэтому трансформации не спорят.
export function heroArt() {
  const piece = (index, float, ...children) => ['g', { class: 'cqa-art-in', style: `--i:${index}` },
    ['g', { class: `cqa-art-float cqa-art-float--${float}` }, ...children]];
  return art('0 0 440 360', 'cqa-art--hero',
    hatch('cqa-hero-hatch'),
    piece(0, 'a', bubble(16, 34, 214, 66, 'client', [[22, 20, 150], [22, 38, 96]])),
    piece(1, 'b', bubble(150, 116, 222, 68, 'operator', [[22, 20, 150, 'line-strong', true], [22, 40, 112, 'line-strong']])),
    piece(2, 'c',
      ['rect', { x: 16, y: 206, width: 336, height: 84, rx: 18, class: 'cqa-art-band' }],
      ['rect', { x: 16, y: 206, width: 10, height: 84, rx: 5, fill: 'url(#cqa-hero-hatch)' }],
      muteIcon(56, 230),
      ['text', { x: 78, y: 235, class: 'cqa-art-label' }, 'клиент не слышит'],
      ['rect', { x: 44, y: 254, width: 132, height: 22, rx: 11, class: 'cqa-art-bubble cqa-art-bubble--internal' }],
      ['rect', { x: 186, y: 254, width: 148, height: 22, rx: 11, class: 'cqa-art-bubble cqa-art-bubble--internal' }]),
    piece(3, 'a', bubble(150, 304, 206, 44, 'operator', [[20, 18, 140, 'line-strong']])),
    piece(4, 'ring',
      ['path', { d: 'M334 136 C 352 128, 362 118, 366 108', class: 'cqa-art-link' }],
      ['circle', { cx: 380, cy: 64, r: 46, class: 'cqa-art-ring-track' }],
      ['circle', { cx: 380, cy: 64, r: 46, class: 'cqa-art-ring-arc', pathLength: 100 }],
      ['circle', { cx: 380, cy: 64, r: 32, class: 'cqa-art-ring-core' }],
      check(381, 64, 1.05)),
  );
}

const SLIDES = {
  // Оценка с доказательством: строка критерия связана с подсвеченной репликой.
  evidence: () => art('0 0 360 240', 'cqa-art--slide',
    ['g', { class: 'cqa-art-in', style: '--i:0' },
      bubble(20, 24, 196, 58, 'client', [[18, 18, 132], [18, 34, 84]])],
    ['g', { class: 'cqa-art-in', style: '--i:1' },
      bubble(104, 92, 216, 58, 'operator', [[18, 16, 136, 'line-strong', true], [18, 34, 96, 'line-strong']])],
    ['g', { class: 'cqa-art-in', style: '--i:2' },
      ['path', { d: 'M150 152 C 150 170, 130 176, 118 182', class: 'cqa-art-link' }],
      ['rect', { x: 20, y: 172, width: 300, height: 48, rx: 14, class: 'cqa-art-card' }],
      ['circle', { cx: 46, cy: 196, r: 12, class: 'cqa-art-ok' }],
      check(46, 196, 0.5),
      ['rect', { x: 68, y: 186, width: 120, height: 7, rx: 3.5, class: 'cqa-art-line-dark' }],
      ['rect', { x: 68, y: 200, width: 72, height: 6, rx: 3, class: 'cqa-art-line' }],
      ['rect', { x: 250, y: 186, width: 52, height: 20, rx: 10, class: 'cqa-art-chip' }]],
  ),
  // Удержание: в звонке видно, что клиент не слышал.
  hold: () => art('0 0 360 240', 'cqa-art--slide',
    hatch('cqa-slide-hatch'),
    ['g', { class: 'cqa-art-in', style: '--i:0' }, bubble(20, 18, 180, 46, 'operator', [[16, 19, 120, 'line-strong']])],
    ['g', { class: 'cqa-art-in', style: '--i:1' },
      ['rect', { x: 20, y: 80, width: 320, height: 92, rx: 18, class: 'cqa-art-band' }],
      ['rect', { x: 20, y: 80, width: 320, height: 92, rx: 18, fill: 'url(#cqa-slide-hatch)', class: 'cqa-art-band-hatch' }],
      muteIcon(56, 104),
      ['text', { x: 78, y: 109, class: 'cqa-art-label' }, 'клиент не слышит'],
      ['rect', { x: 46, y: 128, width: 150, height: 24, rx: 12, class: 'cqa-art-bubble cqa-art-bubble--internal' }],
      ['rect', { x: 206, y: 128, width: 112, height: 24, rx: 12, class: 'cqa-art-bubble cqa-art-bubble--internal' }]],
    ['g', { class: 'cqa-art-in', style: '--i:2' }, bubble(140, 188, 200, 40, 'operator', [[16, 16, 130, 'line-strong']])],
  ),
  // Апелляция: «было → стало», история решений сохраняется.
  appeal: () => art('0 0 360 240', 'cqa-art--slide',
    ['g', { class: 'cqa-art-in', style: '--i:0' },
      ['path', { d: 'M40 44 V 196', class: 'cqa-art-timeline' }],
      ['circle', { cx: 40, cy: 52, r: 7, class: 'cqa-art-dot' }],
      ['circle', { cx: 40, cy: 120, r: 7, class: 'cqa-art-dot' }],
      ['circle', { cx: 40, cy: 188, r: 9, class: 'cqa-art-dot cqa-art-dot--now' }]],
    ['g', { class: 'cqa-art-in', style: '--i:1' },
      ['rect', { x: 70, y: 28, width: 200, height: 76, rx: 16, class: 'cqa-art-card cqa-art-card--muted' }],
      ['circle', { cx: 98, cy: 66, r: 12, class: 'cqa-art-bad' }],
      ['path', { d: 'M93 61l10 10M103 61l-10 10', class: 'cqa-art-cross' }],
      ['rect', { x: 120, y: 56, width: 120, height: 7, rx: 3.5, class: 'cqa-art-line' }],
      ['rect', { x: 120, y: 70, width: 80, height: 7, rx: 3.5, class: 'cqa-art-line' }]],
    ['g', { class: 'cqa-art-in', style: '--i:2' },
      ['path', { d: 'M170 112 v 26', class: 'cqa-art-arrow' }],
      ['path', { d: 'M162 130 l8 9 8 -9', class: 'cqa-art-arrow' }],
      ['rect', { x: 110, y: 148, width: 230, height: 76, rx: 16, class: 'cqa-art-card cqa-art-card--accent' }],
      ['circle', { cx: 140, cy: 186, r: 12, class: 'cqa-art-ok' }],
      check(140, 186, 0.5),
      ['rect', { x: 162, y: 176, width: 140, height: 7, rx: 3.5, class: 'cqa-art-line-dark' }],
      ['rect', { x: 162, y: 190, width: 92, height: 7, rx: 3.5, class: 'cqa-art-line' }]],
  ),
  // Правило без кода: один критерий заменяется новым, остальные на месте.
  rule: () => {
    const row = (y, i, extra = '') => ['g', { class: `cqa-art-in ${extra}`, style: `--i:${i}` },
      ['rect', { x: 30, y, width: 300, height: 40, rx: 12, class: `cqa-art-row${extra ? ' cqa-art-row--new' : ''}` }],
      ['circle', { cx: 54, cy: y + 20, r: 9, class: extra ? 'cqa-art-ok' : 'cqa-art-dot' }],
      extra ? check(54, y + 20, 0.4) : null,
      ['rect', { x: 74, y: y + 13, width: extra ? 150 : 120, height: 7, rx: 3.5, class: 'cqa-art-line-dark' }],
      ['rect', { x: 74, y: y + 24, width: 70, height: 5, rx: 2.5, class: 'cqa-art-line' }],
      ['rect', { x: 286, y: y + 12, width: 30, height: 16, rx: 8, class: extra ? 'cqa-art-toggle cqa-art-toggle--on' : 'cqa-art-toggle' }],
      ['circle', { cx: extra ? 308 : 294, cy: y + 20, r: 6, class: 'cqa-art-toggle-knob' }]];
    return art('0 0 360 240', 'cqa-art--slide',
      row(22, 0),
      ['g', { class: 'cqa-art-in', style: '--i:1' },
        ['rect', { x: 30, y: 74, width: 300, height: 40, rx: 12, class: 'cqa-art-row cqa-art-row--old' }],
        ['rect', { x: 74, y: 90, width: 120, height: 7, rx: 3.5, class: 'cqa-art-line' }],
        ['path', { d: 'M66 94 H 204', class: 'cqa-art-strike' }]],
      row(126, 2, 'cqa-art-swap'),
      row(178, 3),
    );
  },
  // Контрольный набор: разговоры группы заполняются по мере оценки.
  batch: () => {
    const dots = [];
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        const index = r * 8 + c;
        dots.push(['rect', { x: 34 + c * 38, y: 30 + r * 40, width: 28, height: 28, rx: 9, class: index < 17 ? 'cqa-art-cell cqa-art-cell--done' : 'cqa-art-cell', style: `--i:${index}` }]);
      }
    }
    return art('0 0 360 240', 'cqa-art--slide cqa-art--batch',
      ['g', {}, ...dots],
      ['g', { class: 'cqa-art-in', style: '--i:3' },
        ['rect', { x: 34, y: 168, width: 294, height: 12, rx: 6, class: 'cqa-art-track' }],
        ['rect', { x: 34, y: 168, width: 294, height: 12, rx: 6, class: 'cqa-art-fill' }],
        ['rect', { x: 34, y: 196, width: 110, height: 8, rx: 4, class: 'cqa-art-line-dark' }],
        ['rect', { x: 254, y: 192, width: 74, height: 18, rx: 9, class: 'cqa-art-chip' }]],
    );
  },
};

export function slideArt(kind) {
  return (SLIDES[kind] || SLIDES.evidence)();
}

// Значки управления каруселью и ссылок.
const ICONS = {
  prev: ['path', { d: 'M14.5 5.5L8 12l6.5 6.5' }],
  next: ['path', { d: 'M9.5 5.5L16 12l-6.5 6.5' }],
  pause: ['g', {}, ['path', { d: 'M9 6v12' }], ['path', { d: 'M15 6v12' }]],
  play: ['path', { d: 'M8 5.5v13l10.5-6.5z', class: 'cqa-icon-fill' }],
  arrow: ['path', { d: 'M5 12h13M13 6.5l5.5 5.5-5.5 5.5' }],
};

export function icon(name) {
  return svgTree(['svg', { viewBox: '0 0 24 24', class: `cqa-icon cqa-icon--${name}`, ...hidden }, ICONS[name]]);
}
