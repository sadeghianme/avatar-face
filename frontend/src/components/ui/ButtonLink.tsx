import { type AnchorHTMLAttributes, forwardRef } from "react";
import { Link, type LinkProps } from "react-router-dom";

import { buttonClass, type ButtonLook } from "@/components/ui/button-styles";
import { type IconLike, renderIcon } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";

interface Common extends ButtonLook {
  icon?: IconLike;
  iconEnd?: IconLike;
  iconClassName?: string;
}

/** To a page of the app (react-router). */
type RouteLinkProps = Common & LinkProps & { href?: never };
/** Anywhere else: a plain anchor (a share page in a new tab). */
type AnchorLinkProps = Common & AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; to?: never };

/**
 * A link that looks like a Button: a destination, not an action (New
 * avatar, Test in Simulator, Open). Same variants and sizes as Button.
 */
export const ButtonLink = forwardRef<HTMLAnchorElement, RouteLinkProps | AnchorLinkProps>(function ButtonLink(
  { variant, size, fullWidth, icon, iconEnd, iconClassName = "h-4 w-4", className, children, ...rest },
  ref
) {
  const classes = cx(buttonClass({ variant, size, fullWidth }), className);
  const body = (
    <>
      {renderIcon(icon, iconClassName)}
      {children}
      {renderIcon(iconEnd, iconClassName)}
    </>
  );
  if ("href" in rest && rest.href !== undefined) {
    return (
      <a ref={ref} className={classes} {...rest}>
        {body}
      </a>
    );
  }
  return (
    <Link ref={ref} className={classes} {...(rest as LinkProps)}>
      {body}
    </Link>
  );
});
