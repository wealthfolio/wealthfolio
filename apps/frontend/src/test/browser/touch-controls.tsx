import { useState } from "react";
import {
  Button,
  Calendar,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@wealthfolio/ui";
import { PasswordInput } from "@wealthfolio/ui/components/ui/password-input";
import { InputTags } from "@wealthfolio/ui/components/ui/tag-input";
import { DataGridSearch } from "@wealthfolio/ui/components/data-grid/data-grid-search";

const noop = () => {};

export function TouchControlsFixture() {
  const [tags, setTags] = useState(["Income", "Savings"]);
  const [query, setQuery] = useState("");
  return (
    <main className="mx-auto max-w-lg space-y-6 p-4">
      <h1>Touch controls</h1>
      <div>
        <Label htmlFor="touch-username">Username</Label>
        <Input id="touch-username" defaultValue="Synthetic user" />
      </div>
      <div data-testid="password-frame">
        <Label htmlFor="touch-password">Password</Label>
        <PasswordInput
          id="touch-password"
          showLabel="Show password"
          hideLabel="Hide password"
          defaultValue="Synthetic example"
        />
      </div>
      <div data-testid="tags-frame">
        <InputTags aria-label="Tags" value={tags} onChange={setTags} />
      </div>
      <div data-testid="calendar-frame">
        <Calendar mode="single" />
      </div>
      <div className="relative h-36" data-testid="search-frame">
        <DataGridSearch
          searchOpen
          searchQuery={query}
          searchMatches={[]}
          matchIndex={-1}
          onSearchQueryChange={setQuery}
          onSearch={noop}
          onSearchOpenChange={noop}
          onNavigateToNextMatch={noop}
          onNavigateToPrevMatch={noop}
        />
      </div>
      <Tabs defaultValue="general">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="market">Market data</TabsTrigger>
        </TabsList>
        <TabsContent value="general">General settings</TabsContent>
        <TabsContent value="market">Market settings</TabsContent>
      </Tabs>
      <Button size="icon-sm" aria-label="Example action">
        +
      </Button>
    </main>
  );
}
