"use client";

import { motion, type Variants } from "motion/react";
import { Children, type ReactNode } from "react";
import { EASE } from "@/lib/motion";

const STAGGER = 0.06;
const MAX_STAGGERED = 8;

const item: Variants = {
  hidden: { opacity: 0, y: 16 },
  shown: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, ease: EASE, delay: Math.min(i, MAX_STAGGERED - 1) * STAGGER },
  }),
};

type Tag = "div" | "section" | "article" | "header" | "ul" | "ol" | "li" | "tbody" | "tr" | "span" | "p" | "h1" | "h2" | "h3";
const tag = (t: Tag) => (motion as unknown as Record<Tag, typeof motion.div>)[t];

/**
 * Fade + rise 16px, once, when scrolled into view.
 * - Default: reveals itself.
 * - `stagger`: wraps each direct child (as `itemAs`) and staggers them 60ms apart;
 *   items past the 8th arrive with the 8th, so long lists never trickle.
 * Reduced motion: MotionConfig (reducedMotion="user") drops the rise; only a quick fade remains.
 */
export default function Reveal({
  children,
  as = "div",
  className,
  stagger = false,
  itemAs = "div",
  itemClassName,
  delay = 0,
  amount = 0.2,
}: {
  children: ReactNode;
  as?: Tag;
  className?: string;
  stagger?: boolean;
  itemAs?: Tag;
  itemClassName?: string;
  delay?: number;
  amount?: number;
}) {
  const Box = tag(as);
  if (!stagger) {
    return (
      <Box
        className={className}
        initial="hidden"
        whileInView="shown"
        viewport={{ once: true, amount }}
        variants={item}
        custom={delay / STAGGER}
      >
        {children}
      </Box>
    );
  }
  const Item = tag(itemAs);
  return (
    <Box className={className} initial="hidden" whileInView="shown" viewport={{ once: true, amount: 0.1 }}>
      {Children.toArray(children).map((child, i) => (
        <Item key={i} className={itemClassName} variants={item} custom={i}>
          {child}
        </Item>
      ))}
    </Box>
  );
}

/**
 * One staggered item when you can't let Reveal wrap children (e.g. table rows).
 * Put it inside a `<Reveal as=... >`-less parent and pass its index.
 */
export function RevealItem({
  children,
  as = "div",
  index = 0,
  className,
}: {
  children: ReactNode;
  as?: Tag;
  index?: number;
  className?: string;
}) {
  const Item = tag(as);
  return (
    <Item className={className} initial="hidden" whileInView="shown" viewport={{ once: true, amount: 0.1 }} variants={item} custom={index}>
      {children}
    </Item>
  );
}
