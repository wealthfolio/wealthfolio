import { NavLink, useLocation } from "react-router-dom";
import { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@wealthfolio/ui/components/ui/button-variants";

interface SidebarNavProps extends React.HTMLAttributes<HTMLElement> {
  items: {
    href: string;
    title: string;
    icon?: ReactNode;
  }[];
}

export function SidebarNav({ className, items, ...props }: SidebarNavProps) {
  const location = useLocation();

  return (
    <nav className={cn("flex flex-col space-y-1", className)} {...props}>
      {items.map((item) => (
        <NavLink
          key={item.href}
          to={item.href}
          className={cn(
            buttonVariants({ variant: "ghost" }),
            "h-9 min-w-0 justify-start rounded-md px-2 [&_svg]:size-4",
            location.pathname.includes(item.href) ? "bg-muted hover:bg-muted" : "hover:bg-muted/50",
          )}
          title={item.title}
        >
          {item.icon && <span className="mr-1.5 hidden lg:inline-block">{item.icon}</span>}
          <span className="min-w-0 flex-1 truncate text-left">{item.title}</span>
        </NavLink>
      ))}
    </nav>
  );
}
