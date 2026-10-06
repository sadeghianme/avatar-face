import { type ReactNode, useEffect, useRef, useState } from "react";

import { cx } from "@/lib/cx";

/**
 * Fade-and-rise as a block scrolls into view, once. Under reduced motion it
 * is simply shown: the observer is never created.
 */
export function Reveal({
  children,
  className = "",
  delay = 0,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: "div" | "li" | "section";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <Tag
      ref={ref as never}
      style={{ transitionDelay: shown ? `${delay}ms` : "0ms" }}
      className={cx(
        "transition-[opacity,transform] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]",
        shown ? "translate-y-0 opacity-100" : "translate-y-5 opacity-0",
        className
      )}
    >
      {children}
    </Tag>
  );
}

/** Eyebrow + title + optional subtitle, the header every section shares. */
export function SectionHeader({
  eyebrow,
  title,
  subtitle,
  align = "center",
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  align?: "center" | "start";
}) {
  const centered = align === "center";
  return (
    <Reveal className={centered ? "mx-auto max-w-2xl text-center" : "max-w-xl"}>
      <p className="text-[13px] font-semibold uppercase tracking-[0.14em] text-brand-600 dark:text-brand-400">
        {eyebrow}
      </p>
      <h2 className="mt-3 text-balance text-[32px] font-semibold leading-[1.1] tracking-[-0.03em] text-gray-950 sm:text-[42px] dark:text-white">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-4 text-pretty text-[17px] leading-relaxed text-gray-600 dark:text-gray-400">{subtitle}</p>
      )}
    </Reveal>
  );
}
