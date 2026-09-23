import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** Numbers that are properties of the product, not of a marketing plan. */
const PROOF = [
  { value: 478, key: "proofLandmarks" },
  { value: 15, key: "proofVisemes" },
  { value: 13, key: "proofLanguages" },
  { value: 1, key: "proofEmbed" },
];

function CountUp({ to }: { to: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState(to);
  useEffect(() => {
    const node = ref.current;
    if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setValue(0);
    let raf = 0;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      const begin = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - begin) / 1300);
        setValue(Math.round(to * (1 - (1 - k) ** 4)));
        if (k < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [to]);
  return <span ref={ref}>{value}</span>;
}

export function ProofStrip() {
  const { t } = useTranslation();
  return (
    <section aria-label={t("proofLabel")} className="border-y border-black/[0.06] bg-white/60 dark:border-white/[0.07] dark:bg-white/[0.015]">
      <dl className="mx-auto grid max-w-7xl grid-cols-2 px-5 sm:px-6 lg:grid-cols-4">
        {PROOF.map((item, i) => (
          <div
            key={item.key}
            className={`flex flex-col px-2 py-8 sm:px-6 lg:py-10 ${i % 2 === 1 ? "border-s border-black/[0.06] dark:border-white/[0.07]" : ""} ${
              i >= 2 ? "border-t border-black/[0.06] lg:border-t-0 dark:border-white/[0.07]" : ""
            } ${i === 2 ? "lg:border-s" : ""}`}
          >
            <dt className="order-2 mt-1 text-[13.5px] leading-snug text-gray-500 dark:text-gray-400">{t(item.key)}</dt>
            <dd className="text-[40px] font-semibold tracking-[-0.04em] text-gray-950 tabular-nums sm:text-[48px] dark:text-white">
              <CountUp to={item.value} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
