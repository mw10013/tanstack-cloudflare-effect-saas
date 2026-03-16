import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

interface ProbeSuccess {
  ok: true;
  transport: string;
  model: string;
  elapsedMs: number;
  text: string;
  raw: unknown;
}

interface ProbeFailure {
  ok: false;
  transport: string;
  model: string;
  elapsedMs: number;
  error: string;
}

type ProbeResult = ProbeSuccess | ProbeFailure;

export const Route = createFileRoute("/app/$organizationId/ai-probe")({
  component: RouteComponent,
});

function RouteComponent() {
  const [prompt, setPrompt] = React.useState(
    "What is the origin of the phrase Hello, World",
  );
  const mutation = useMutation<ProbeResult, Error, "direct" | "gateway">({
    mutationFn: async (transport: "direct" | "gateway") => {
      const response = await fetch("/api/ai-probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, transport }),
      });
      return await response.json();
    },
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">AI Probe</h1>
        <p className="text-sm text-muted-foreground">
          Probe route aligned with the direct test model and gateway config.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Run Probe</CardTitle>
          <CardDescription>
            API route now matches `src/routes/ai-direct.tsx`: model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, direct prompt call, and gateway with `skipCache: true`.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Textarea
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
            }}
            className="min-h-32"
          />
          <div className="flex items-center gap-3">
            <Button
              onClick={() => {
                mutation.mutate("direct");
              }}
              disabled={mutation.isPending || prompt.trim().length === 0}
              variant="outline"
            >
              {mutation.isPending ? "Running..." : "Run Direct Probe"}
            </Button>
            <Button
              onClick={() => {
                mutation.mutate("gateway");
              }}
              disabled={mutation.isPending || prompt.trim().length === 0}
            >
              {mutation.isPending ? "Running..." : "Run Gateway Probe"}
            </Button>
            {mutation.data && (
              <p className="text-sm text-muted-foreground">
                Transport: {mutation.data.transport} - Model: {mutation.data.model} - {mutation.data.elapsedMs}ms
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {mutation.data?.ok === false && (
        <Alert variant="destructive">
          <AlertTitle>Probe failed</AlertTitle>
          <AlertDescription>{mutation.data.error}</AlertDescription>
        </Alert>
      )}

      {mutation.data?.ok === true && (
        <Card>
          <CardHeader>
            <CardTitle>Probe Result</CardTitle>
            <CardDescription>Returned text and raw payload.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-medium">Text</h4>
              <pre className="overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-4 text-xs leading-5">
                {mutation.data.text}
              </pre>
            </div>
            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-medium">Raw</h4>
              <pre className="overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-4 text-xs leading-5">
                {JSON.stringify(mutation.data.raw, null, 2)}
              </pre>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
