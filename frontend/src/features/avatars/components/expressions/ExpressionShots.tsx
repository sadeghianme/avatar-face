import type { ShotView } from "@/features/avatars/expressions";
import { useT } from "@/i18n";
import { cx } from "@/lib/cx";

/**
 * The five expressions as a grid: each made picture (what the AI drew,
 * before the engine lays its upper face over the moving one), or, for one
 * the AI could not make, that it stays animated and why.
 */
export function ExpressionShots({ shots }: { shots: ShotView[] }) {
  const { t } = useT();
  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5" aria-label={t("exprShotsLabel")}>
      {shots.map((shot) => (
        <li key={shot.name} className="min-w-0">
          <figure
            className={cx(
              "overflow-hidden rounded-lg border",
              shot.made ? "border-black/10 dark:border-white/10" : "border-dashed border-black/15 dark:border-white/15"
            )}
          >
            {shot.pictureUrl ? (
              <img
                src={shot.pictureUrl}
                alt={t("exprShotAlt", { name: t(`exprName_${shot.name}`) })}
                className="aspect-square w-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="flex aspect-square w-full items-center justify-center bg-black/[0.03] p-1.5 text-center text-[11px] leading-tight text-gray-500 dark:bg-white/[0.04]">
                {t("exprShotAnimated")}
              </div>
            )}
            <figcaption className="px-1.5 py-1 text-[11.5px] font-medium">
              {t(`exprName_${shot.name}`)}
              {shot.smile && <span className="block text-[10.5px] font-normal text-gray-500">{t("exprSmile")}</span>}
              {(shot.reasonKey || shot.reasonText) && (
                <span className="block text-[10.5px] font-normal leading-snug text-gray-500">
                  {shot.reasonKey ? t(shot.reasonKey) : shot.reasonText}
                </span>
              )}
            </figcaption>
          </figure>
        </li>
      ))}
    </ul>
  );
}
