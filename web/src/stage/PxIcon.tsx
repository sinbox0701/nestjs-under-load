import { ICON, type IconName } from './sprites';

/** 8×8 도트 아이콘(캔버스와 같은 원본, DESIGN_SYSTEM §4.12). 글자와 함께만 쓴다. */
export function PxIcon({ name }: { name: IconName }) {
  const cells: string[] = [];
  ICON[name].forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') cells.push(`M${x} ${y}h1v1h-1z`);
  });
  return (
    <svg
      className="px-ico"
      viewBox="0 0 8 8"
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <path d={cells.join('')} />
    </svg>
  );
}
