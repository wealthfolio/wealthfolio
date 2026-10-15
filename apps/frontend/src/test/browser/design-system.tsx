import { type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import i18next from "@/i18n/i18n";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Progress,
  RadioGroup,
  RadioGroupItem,
  ScrollArea,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Separator,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Toggle,
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  buttonVariants,
} from "@wealthfolio/ui";
import "@/globals.css";

// Synthetic fixture for the UI-primitive guardrails: every primitive in
// @wealthfolio/ui in its key states, each overlay opened from a named trigger.
// No financial data and no backend.

const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "dark" ? "dark" : "light";
document.documentElement.classList.add(mode);
document.documentElement.style.colorScheme = mode;

const currencies = ["USD", "EUR", "GBP", "CHF", "JPY", "CAD"];
// An inline image, so the avatar loads without a network request.
const avatarImage =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#4f7d6b"/><circle cx="20" cy="16" r="7" fill="#e9efe9"/><rect x="8" y="26" width="24" height="12" rx="6" fill="#e9efe9"/></svg>',
  );
const accounts = Array.from({ length: 12 }, (_, index) => `Synthetic account ${index + 1}`);

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = title.toLowerCase().replaceAll(" ", "-");
  return (
    <section aria-labelledby={id} data-testid={`section-${id}`} className="space-y-4">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function CurrencyCombobox() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("USD");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" role="combobox" aria-expanded={open} aria-label="Currency" />
        }
      >
        {value}
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0">
        <Command>
          <CommandInput placeholder="Search currency" />
          <CommandList>
            <CommandEmpty>No currency found.</CommandEmpty>
            <CommandGroup>
              {currencies.map((currency) => (
                <CommandItem
                  key={currency}
                  value={currency}
                  onSelect={() => {
                    setValue(currency);
                    setOpen(false);
                  }}
                >
                  {currency}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function SampleSelect({ label }: { label: string }) {
  return (
    <Select
      defaultValue="brokerage"
      items={{
        brokerage: "Brokerage",
        retirement: "Retirement",
        checking: "Checking",
        savings: "Savings",
      }}
    >
      <SelectTrigger aria-label={label} className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Investments</SelectLabel>
          <SelectItem value="brokerage">Brokerage</SelectItem>
          <SelectItem value="retirement">Retirement</SelectItem>
        </SelectGroup>
        <SelectGroup>
          <SelectLabel>Cash</SelectLabel>
          <SelectItem value="checking">Checking</SelectItem>
          <SelectItem value="savings" disabled>
            Savings
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function Fixture() {
  const [showFees, setShowFees] = useState(true);
  const [density, setDensity] = useState("comfortable");
  const [deleted, setDeleted] = useState(false);
  return (
    <TooltipProvider delay={0}>
      <main className="mx-auto max-w-5xl space-y-10 p-4 sm:p-8">
        <header>
          <p className="text-muted-foreground text-xs">WEALTHFOLIO · SYNTHETIC FIXTURE</p>
          <h1 className="text-2xl font-semibold">UI primitives</h1>
        </header>

        <Section title="Buttons and badges">
          <div className="flex flex-wrap items-center gap-3">
            <Button>Primary action</Button>
            <Button variant="outline">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Delete</Button>
            <Button disabled>Unavailable</Button>
            <a href="#buttons-and-badges" className={buttonVariants({ variant: "link" })}>
              Link button
            </a>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Badge>Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="destructive">Destructive</Badge>
            <Badge render={<a href="#buttons-and-badges" />}>Link badge</Badge>
          </div>
        </Section>

        <Section title="Form controls">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="account-name">Account name</Label>
              <Input id="account-name" placeholder="Example account" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invalid-field">Invalid field</Label>
              <Input id="invalid-field" aria-invalid="true" defaultValue="Invalid value" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="disabled-field">Disabled field</Label>
              <Input id="disabled-field" disabled value="Unavailable" readOnly />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-6">
            <Label className="flex items-center gap-2">
              <Checkbox defaultChecked />
              Include closed accounts
            </Label>
            <Label className="flex items-center gap-2">
              <Checkbox />
              Include archived
            </Label>
            <Label className="flex items-center gap-2">
              <Checkbox disabled />
              Locked option
            </Label>
            <Label className="flex items-center gap-2">
              <Checkbox indeterminate />
              Select all
            </Label>
            <Label className="flex items-center gap-2">
              <Switch checked={showFees} onCheckedChange={setShowFees} />
              Show fees
            </Label>
            <Label className="flex items-center gap-2">
              <Switch disabled />
              Locked switch
            </Label>
          </div>
          <div className="flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-2">
              <Switch id="sync-switch" />
              <Label htmlFor="sync-switch">Sync automatically</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="terms-checkbox" />
              <Label htmlFor="terms-checkbox">Accept terms</Label>
            </div>
          </div>
          <RadioGroup
            aria-label="Density"
            value={density}
            onValueChange={setDensity}
            className="flex gap-6"
          >
            {["compact", "comfortable", "spacious"].map((value) => (
              <div key={value} className="flex items-center gap-2">
                <RadioGroupItem
                  value={value}
                  id={`density-${value}`}
                  disabled={value === "spacious"}
                />
                <Label htmlFor={`density-${value}`} className="capitalize">
                  {value}
                </Label>
              </div>
            ))}
          </RadioGroup>
          <div className="flex flex-wrap items-center gap-6">
            <Progress value={40} aria-label="Import progress" className="w-48" />
            <Separator orientation="vertical" className="h-6" />
            <Avatar>
              <AvatarFallback>WF</AvatarFallback>
            </Avatar>
            <Avatar>
              <AvatarImage src={avatarImage} alt="Synthetic avatar" />
              <AvatarFallback>SA</AvatarFallback>
            </Avatar>
            <Toggle aria-label="Bold" defaultPressed>
              B
            </Toggle>
            <Toggle aria-label="Italic">I</Toggle>
          </div>
          <Separator />
          <div className="flex flex-wrap items-center gap-6">
            <ToggleGroup defaultValue={["1m"]} aria-label="Range">
              {["1w", "1m", "1y", "all"].map((value) => (
                <ToggleGroupItem key={value} value={value} className="uppercase">
                  {value}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ToggleGroup multiple defaultValue={["stocks"]} aria-label="Asset types">
              {["stocks", "bonds", "cash"].map((value) => (
                <ToggleGroupItem key={value} value={value} className="capitalize">
                  {value}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </Section>

        <Section title="Navigation">
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="holdings">Holdings</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">Overview panel</TabsContent>
            <TabsContent value="holdings">Holdings panel</TabsContent>
            <TabsContent value="activity">Activity panel</TabsContent>
          </Tabs>
          <Accordion defaultValue={["fees"]} className="max-w-md">
            <AccordionItem value="fees">
              <AccordionTrigger>Fees</AccordionTrigger>
              <AccordionContent>Synthetic fee explanation.</AccordionContent>
            </AccordionItem>
            <AccordionItem value="taxes">
              <AccordionTrigger>Taxes</AccordionTrigger>
              <AccordionContent>Synthetic tax explanation.</AccordionContent>
            </AccordionItem>
          </Accordion>
          <Collapsible defaultOpen className="max-w-md space-y-2">
            <CollapsibleTrigger render={<Button variant="ghost" />}>
              Toggle details
            </CollapsibleTrigger>
            <CollapsibleContent>Collapsible details</CollapsibleContent>
          </Collapsible>
          <ScrollArea className="h-32 max-w-md rounded-md border" data-testid="scroll-area">
            <ul className="p-3 text-sm">
              {accounts.map((account) => (
                <li key={account} className="py-1">
                  {account}
                </li>
              ))}
            </ul>
          </ScrollArea>
        </Section>

        <Section title="Overlays">
          <div className="flex flex-wrap items-center gap-3">
            <Dialog>
              <DialogTrigger render={<Button variant="outline" />}>Open dialog</DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Review activity</DialogTitle>
                  <DialogDescription>Synthetic fixture. Nothing is saved.</DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                  <Label htmlFor="dialog-note">Note</Label>
                  <Input id="dialog-note" defaultValue="Example activity" />
                </div>
                <div className="flex items-center gap-3">
                  <CurrencyCombobox />
                  <SampleSelect label="Dialog account" />
                </div>
              </DialogContent>
            </Dialog>

            <AlertDialog>
              <AlertDialogTrigger render={<Button variant="destructive" />}>
                Delete account
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this account?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Synthetic fixture. Nothing is deleted.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => setDeleted(true)}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <span role="status">{deleted ? "Deleted" : ""}</span>

            <Sheet>
              <SheetTrigger render={<Button variant="outline" />}>Open sheet</SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Edit account</SheetTitle>
                  <SheetDescription>Synthetic fixture. Nothing is saved.</SheetDescription>
                </SheetHeader>
                <div className="space-y-4 p-4">
                  <div className="space-y-2">
                    <Label htmlFor="sheet-name">Name</Label>
                    <Input id="sheet-name" defaultValue="Brokerage" />
                  </div>
                  <SampleSelect label="Sheet account" />
                </div>
              </SheetContent>
            </Sheet>

            <Sheet>
              <SheetTrigger render={<Button variant="outline" />}>Open bottom sheet</SheetTrigger>
              <SheetContent side="bottom">
                <SheetHeader>
                  <SheetTitle>Quick add</SheetTitle>
                  <SheetDescription>Synthetic fixture. Nothing is saved.</SheetDescription>
                </SheetHeader>
                <div className="p-4">
                  <Label htmlFor="bottom-amount">Amount</Label>
                  <Input id="bottom-amount" inputMode="decimal" defaultValue="12.50" />
                </div>
              </SheetContent>
            </Sheet>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Popover>
              <PopoverTrigger render={<Button variant="outline" />}>Open popover</PopoverTrigger>
              <PopoverContent className="space-y-2">
                <Label htmlFor="popover-target">Target allocation</Label>
                <Input id="popover-target" defaultValue="60" />
              </PopoverContent>
            </Popover>

            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" />}>
                Open menu
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Account</DropdownMenuLabel>
                  <DropdownMenuItem>Rename</DropdownMenuItem>
                  <DropdownMenuItem>Duplicate</DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem>Investments</DropdownMenuItem>
                      <DropdownMenuItem>Cash</DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem checked={showFees} onCheckedChange={setShowFees}>
                  Show fees
                </DropdownMenuCheckboxItem>
                <DropdownMenuRadioGroup value={density} onValueChange={setDensity}>
                  <DropdownMenuRadioItem value="compact">Compact</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="comfortable">Comfortable</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled>Archive</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <SampleSelect label="Account type" />

            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" />}>Fee info</TooltipTrigger>
              <TooltipContent>Fees are deducted from cash.</TooltipContent>
            </Tooltip>

            <HoverCard>
              <HoverCardTrigger
                delay={0}
                closeDelay={0}
                render={<a href="#overlays" className="text-sm underline" />}
              >
                ACME
              </HoverCardTrigger>
              <HoverCardContent>Acme Global Equity — synthetic security.</HoverCardContent>
            </HoverCard>
          </div>
        </Section>
      </main>
    </TooltipProvider>
  );
}

void i18next.changeLanguage("en").then(() => {
  createRoot(document.getElementById("root")!).render(<Fixture />);
});
