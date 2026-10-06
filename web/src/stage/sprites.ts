/**
 * 무대 도트 비트맵(DESIGN_SYSTEM §1.1, §4.12, §5).
 * 문자열 배열 + 문자 → 팔레트 매핑으로만 정의한다. 외부 이미지·스프라이트시트를 쓰지 않는다.
 * 원본은 design/mockup.html §1과 같고, G02(창구·재고 상자·주문 손님)는 같은 규칙으로 새로 그렸다.
 */

/**
 * 팔레트 글자(12색 + 캔버스 전용 보조 음영 2개 d·n). 다크 테마에서도 바꾸지 않는다.
 * k=ink s=slate m=mist h=shell p=paper g=ok y=wait r=bad o=retry b=info f=skin w=wood
 */
export const PAL = {
  k: 0x1e222a,
  s: 0x4b5262,
  m: 0xb9c0ca,
  h: 0xe2e4e8,
  p: 0xf6f7f3,
  g: 0x1f7f45,
  y: 0xe2ae24,
  r: 0xcc3b34,
  o: 0xeb7a2c,
  b: 0x2f6bcb,
  f: 0xf0c39c,
  w: 0x94704f,
  d: 0x7a5a3e,
  n: 0xd3d8de,
} as const;

export type PalKey = keyof typeof PAL;
/** 비트맵 글자 → 팔레트 글자 치환표(예: S=정장색, T=넥타이색). */
export type ColorMap = Readonly<Record<string, PalKey>>;
export type Bitmap = readonly string[];

export function isPalKey(c: string): c is PalKey {
  return Object.prototype.hasOwnProperty.call(PAL, c);
}

/** 8×8 도트 아이콘. UI(svg)와 캔버스가 같은 원본을 쓴다(§4.12). */
export const ICON = {
  arrive: [
    '...#....',
    '...##...',
    '######..',
    '#######.',
    '######..',
    '...##...',
    '...#....',
    '........',
  ],
  wait: [
    '#######.',
    '#.....#.',
    '.#...#..',
    '..#.#...',
    '..#.#...',
    '.#.#.#..',
    '#######.',
    '........',
  ],
  bang: [
    '..###...',
    '..###...',
    '..###...',
    '..###...',
    '...#....',
    '........',
    '..###...',
    '........',
  ],
  retry: [
    '..####..',
    '.#....#.',
    '#....###',
    '#.....#.',
    '#.......',
    '#.....#.',
    '.#...#..',
    '..###...',
  ],
  check: [
    '........',
    '......##',
    '.....##.',
    '#...##..',
    '##.##...',
    '.###....',
    '..#.....',
    '........',
  ],
  cross: [
    '##...##.',
    '.##.##..',
    '..###...',
    '..###...',
    '.##.##..',
    '##...##.',
    '........',
    '........',
  ],
  lock: [
    '..###...',
    '.#...#..',
    '.#...#..',
    '#######.',
    '###.###.',
    '###.###.',
    '#######.',
    '........',
  ],
  unlock: [
    '..###...',
    '.#...#..',
    '.#......',
    '#######.',
    '###.###.',
    '###.###.',
    '#######.',
    '........',
  ],
  read: [
    '######..',
    '#....#..',
    '#.##.#..',
    '#....#..',
    '#.##.#..',
    '#....#..',
    '######..',
    '........',
  ],
  write: [
    '.....##.',
    '....####',
    '...####.',
    '..####..',
    '.####...',
    '###.....',
    '##......',
    '........',
  ],
  play: [
    '##......',
    '####....',
    '######..',
    '#######.',
    '######..',
    '####....',
    '##......',
    '........',
  ],
  stop: [
    '........',
    '.######.',
    '.######.',
    '.######.',
    '.######.',
    '.######.',
    '.######.',
    '........',
  ],
  out: [
    '....#...',
    '....##..',
    '#######.',
    '########',
    '#######.',
    '....##..',
    '....#...',
    '........',
  ],
} as const satisfies Record<string, Bitmap>;

export type IconName = keyof typeof ICON;

/** 직원 12×18(머리·몸 14줄 + 다리 4줄) — S=정장, T=넥타이. G01 shared-document. */
export const STAFF: Bitmap = [
  '....kkkk....',
  '...kkkkkk...',
  '..kkkkkkkk..',
  '..kffffffk..',
  '..fkfffkff..',
  '..ffffffff..',
  '...ffffff...',
  '....pTTp....',
  '..SSpTTpSS..',
  '.SSSSTTSSSS.',
  '.SSSSTTSSSS.',
  '.fSSSSSSSSf.',
  '.fSSSSSSSSf.',
  '..SSSSSSSS..',
];

/**
 * 주문 손님 12×18 — G02 queue-at-counter. 직원과 구분되게 모자(T)·티셔츠(S)·허리띠(T).
 * 색 치환은 직원과 같은 SUITS를 써서 이름표(A/B/C/D) 색과 맞춘다.
 */
export const CUSTOMER: Bitmap = [
  '....TTTT....',
  '...TTTTTT...',
  '..TTTTTTTTT.',
  '..kffffffk..',
  '..fkfffkff..',
  '..ffffffff..',
  '...ffffff...',
  '....ffff....',
  '..SSSSSSSS..',
  '.SSSSSSSSSS.',
  '.SSSSppSSSS.',
  '.fSSSSSSSSf.',
  '.fSSSSSSSSf.',
  '..TTTTTTTT..',
];

/** 다리 3프레임. 걸을 때 140 무대ms마다 a/b를 바꾼다. */
export const LEGS = {
  stand: ['...kk..kk...', '...kk..kk...', '...kk..kk...', '..kkk..kkk..'],
  a: ['...kk..kk...', '..kk....kk..', '..kk....kk..', '.kkk.....kk.'],
  b: ['...kk..kk...', '...kk..kk...', '...kk.kk....', '..kkk.kkk...'],
} as const satisfies Record<string, Bitmap>;

/** actor 색(상태 색을 쓰지 않는다, §1.2). 이름표 칩 a0..a3과 같은 순서. */
export const SUITS: readonly ColorMap[] = [
  { S: 's', T: 'w' },
  { S: 'w', T: 'k' },
  { S: 'k', T: 'b' },
  { S: 'm', T: 's' },
];

export function suitOf(i: number): ColorMap {
  return SUITS[((i % SUITS.length) + SUITS.length) % SUITS.length]!;
}

/** 멈춘 보유자(GC·네트워크 단절): 회색 실루엣. */
export const GHOST: ColorMap = { k: 's', f: 'm', p: 'h', S: 'm', T: 'm' };
export const GHOST_LEGS: ColorMap = { k: 's' };

/** 들고 있는 사본(G01) · 주문서(G02) 7×7. */
export const COPY: Bitmap = [
  'kkkkkk.',
  'kppppkk',
  'kpkkkpk',
  'kpppppk',
  'kpkkkpk',
  'kpppppk',
  'kkkkkkk',
];

/** 자물쇠 7×8. m=몸통. */
export const PADLOCK: Bitmap = [
  '..kkk..',
  '.k...k.',
  '.k...k.',
  'kkkkkkk',
  'kmmmmmk',
  'kmmkmmk',
  'kmmkmmk',
  'kkkkkkk',
];
/** 만료된 자물쇠: 회색. 빨간 사선은 따로 그린다. */
export const PADLOCK_EXPIRED: ColorMap = { k: 's', m: 'h' };

/**
 * 재고 상자 16×11(G02, DB의 재고 행). 앞면에 종이 라벨(p)과 바코드 줄(k).
 * 초과 판매 때는 외곽선을 빨강으로 바꿔 그린다(k→r).
 */
export const CRATE: Bitmap = [
  'kkkkkkkkkkkkkkkk',
  'kwwwwwwwwwwwwwwk',
  'kwddddddddddddwk',
  'kwwwwwwwwwwwwwwk',
  'kwwppppppppppwwk',
  'kwwpkpkkpkpkpwwk',
  'kwwppppppppppwwk',
  'kwwwwwwwwwwwwwwk',
  'kwddddddddddddwk',
  'kwwwwwwwwwwwwwwk',
  'kkkkkkkkkkkkkkkk',
];
export const CRATE_OVERSOLD: ColorMap = { k: 'r' };

/** 8×8 아이콘을 한 색으로 칠하는 치환표. */
export function iconMap(color: PalKey): ColorMap {
  return { '#': color };
}
