import { MARK, CANVAS } from "../pwa/icon-art";
import { useEdition } from "../editions/EditionContext";
import { useTranslation } from "../i18n";
import { paletteOf } from "./palettes";

export interface BrandMarkProps {
  /** Side of the square tile in CSS pixels. */
  size: number;
  /** Name it for assistive technology (the sign-in page); a logo that sits beside its own name stays hidden. */
  labelled?: boolean;
  className?: string;
}

/** The app icon of the edition drawn from the master shape (`src/pwa/icon-art.ts`): the same geometry as the PWA icons, so the shell, the tab and the phone agree. */
export function BrandMark({
  size,
  labelled = false,
  className,
}: BrandMarkProps) {
  const { t } = useTranslation();
  const { manifest } = useEdition();
  const palette = paletteOf(manifest.edition).mark;
  const label = labelled
    ? t("logo.mark.alt", { product: t("shell.brand.name.text") })
    : undefined;
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${CANVAS} ${CANVAS}`}
      width={size}
      height={size}
      role={labelled ? "img" : undefined}
      aria-label={label}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      data-edition={manifest.edition}
      data-monogram={t('shell.brand.mark.text')}
    >
      <rect width={CANVAS} height={CANVAS} rx={112} fill={palette.background} />
      {MARK.map((shape, index) =>
        shape.points === undefined ? (
          <rect
            key={index}
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            rx={shape.radius}
            fill={palette[shape.fill]}
          />
        ) : (
          <polygon
            key={index}
            points={shape.points.map(([x, y]) => `${x},${y}`).join(" ")}
            fill={palette[shape.fill]}
          />
        ),
      )}
    </svg>
  );
}
