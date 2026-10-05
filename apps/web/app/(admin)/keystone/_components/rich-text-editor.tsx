"use client";

// Tiptap rich-text editor (changes-02; ADR-009's "editor lands after the
// pipeline" — the pipeline is already there). HTML in, HTML out: the
// editor ingests the stored body and emits markup that sanitizeRichText()
// passes through unchanged (core's sanitize-tiptap.test.ts pins the
// vocabulary). Sanitization still happens SERVER-side on save — this widget
// is authoring convenience, never the boundary. Admin-only dependency
// (architecture.md #5): lives under the admin route group, never imported
// by (public).
//
// changes-10 (ADR-046) grew it into a full article editor:
//
//   - Tone, highlight, family, size and alignment, all CLASS-based (see
//     editor-extensions.ts for why none of them may be inline styles).
//   - Tables, via @tiptap/extension-table with resizing OFF — a resizable
//     table stores its widths as inline styles on <col>, which the
//     sanitizer strips, so the handles would lie.
//   - Provider video embeds, parsed through the same whitelist the
//     article-level video field uses.
//   - An HTML source mode. Safe by construction: whatever is typed there
//     goes through sanitizeRichText on save like everything else, so the
//     source view can only express what the vocabulary already allows.
import * as React from "react";
import { useTranslations } from "next-intl";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  ChevronDown,
  Code,
  Code2,
  Columns3,
  Eraser,
  Heading2,
  Heading3,
  Heading4,
  Highlighter,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  Rows3,
  Strikethrough,
  Table as TableIcon,
  Type,
  Underline,
  Undo2,
  Unlink,
  Video,
  Eye,
} from "lucide-react";
import { parseVideoUrl } from "@repo/utils";
import { Button } from "@repo/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { useFieldContext } from "@repo/ui/components/field";
import { Separator } from "@repo/ui/components/separator";
import { Textarea } from "@repo/ui/components/textarea";
import { cn } from "@repo/ui/lib/utils";
import { useUploadProgress } from "../_hooks/use-upload-progress.ts";
import { UploadProgress } from "./upload-progress.tsx";
import {
  AI_RESULT_IDLE,
  AiAssistantMenu,
  AiResultPanel,
  type AiAssistantConfig,
  type AiAssistantLabels,
  type AiResultState,
} from "./ai-assistant.tsx";
import { describeOversizeFile } from "./media-constraints.ts";
import { MediaPickerDialog } from "./media-picker-dialog.tsx";
import { isEmailVariableName, type MediaCategory } from "@repo/contracts";
import {
  EDITORIAL_EXTENSIONS,
  EMAIL_EXTENSIONS,
  EDITOR_ALIGNMENTS,
  EDITOR_FONTS,
  EDITOR_SIZES,
  EDITOR_TONES,
  ALIGNABLE_TYPES,
  type EditorAlignment,
  type EditorFont,
  type EditorSize,
  type EditorTone,
} from "./editor-extensions.ts";
import type { StoredImage } from "@repo/core";

export interface RichTextLabels {
  toolbar: string;
  bold: string;
  italic: string;
  underline: string;
  strike: string;
  paragraph: string;
  heading2: string;
  heading3: string;
  heading4: string;
  blockType: string;
  bulletList: string;
  orderedList: string;
  blockquote: string;
  codeBlock: string;
  link: string;
  unlink: string;
  image: string;
  horizontalRule: string;
  undo: string;
  redo: string;
  linkPrompt: string;
  placeholder: string;
  fontFamily: string;
  fonts: Record<EditorFont, string>;
  fontSize: string;
  sizes: Record<EditorSize, string>;
  textColor: string;
  highlight: string;
  tones: Record<EditorTone, string>;
  defaultOption: string;
  align: string;
  alignments: Record<EditorAlignment, string>;
  table: string;
  insertTable: string;
  addRowAfter: string;
  addColumnAfter: string;
  deleteRow: string;
  deleteColumn: string;
  toggleHeaderRow: string;
  deleteTable: string;
  video: string;
  videoPrompt: string;
  videoInvalid: string;
  clearFormatting: string;
  modeVisual: string;
  modeHtml: string;
  htmlHint: string;
}

const TONE_SWATCH: Record<EditorTone, string> = {
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  info: "bg-info",
  danger: "bg-destructive",
  muted: "bg-muted-foreground",
};

const ALIGN_ICON: Record<EditorAlignment, typeof AlignLeft> = {
  // `start`/`end` are logical; the glyphs are LTR-shaped and flip with the
  // document the same way every other directional icon in the admin does.
  start: AlignLeft,
  center: AlignCenter,
  end: AlignRight,
  justify: AlignJustify,
};

function ToolbarButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="icon-sm"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      // Keep the editor selection: a mousedown on the toolbar would blur it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/** A labelled dropdown trigger, for the pickers that don't fit one glyph. */
function ToolbarMenu({
  label,
  icon,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={label}
            title={label}
            className="gap-0.5 px-1.5"
            onMouseDown={(e) => e.preventDefault()}
          >
            {icon}
            <ChevronDown aria-hidden className="size-3 opacity-60" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The canvas mirrors the public article body's typography, so what admins
// see is what readers get. `break-words` + the scroll containers on pre/table
// are what stop a pasted 400-character URL or a wide code block from widening
// the whole page (changes-10 item 9) — the editor is inside a grid track, and
// without these the track grows to fit the content and pushes the sidebar off
// screen.
const EDITOR_CANVAS =
  "min-h-96 max-w-none px-3 py-2 text-sm leading-relaxed break-words outline-none [&_a]:text-primary-interactive [&_a]:underline-offset-4 [&_a:hover]:underline [&_blockquote]:border-s-2 [&_blockquote]:ps-4 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-sm [&_h2]:mt-4 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:text-lg [&_h3]:font-semibold [&_h4]:font-semibold [&_hr]:my-4 [&_img]:my-2 [&_img]:max-h-96 [&_img]:rounded-lg [&_ol]:list-decimal [&_ol]:ps-5 [&_p]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4 [&_ul]:list-disc [&_ul]:ps-5 [&_table]:my-3 [&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse [&_td]:border [&_td]:p-2 [&_td]:align-top [&_th]:border [&_th]:bg-muted/50 [&_th]:p-2 [&_th]:text-start [&_.selectedCell]:bg-primary/10 [&_.is-editor-empty:first-child]:before:pointer-events-none [&_.is-editor-empty:first-child]:before:float-start [&_.is-editor-empty:first-child]:before:h-0 [&_.is-editor-empty:first-child]:before:text-muted-foreground [&_.is-editor-empty:first-child]:before:content-placeholder";

// changes-61: an email body's block classes, drawn roughly as the message
// draws them so an author can see which paragraph is the button or the code.
// The preview remains the true render.
const EMAIL_CANVAS =
  "[&_.ed-panel]:bg-muted [&_.ed-panel]:p-4 [&_.ed-code]:font-mono [&_.ed-code]:text-2xl [&_.ed-code]:font-bold [&_.ed-code]:tracking-widest [&_.ed-eyebrow]:text-2xs [&_.ed-eyebrow]:font-bold [&_.ed-eyebrow]:tracking-caps [&_.ed-eyebrow]:text-primary-interactive [&_.ed-eyebrow]:uppercase [&_.ed-title]:text-2xl [&_.ed-title]:font-extrabold [&_a.ed-btn]:inline-block [&_a.ed-btn]:rounded-md [&_a.ed-btn]:bg-primary [&_a.ed-btn]:px-5 [&_a.ed-btn]:py-2 [&_a.ed-btn]:font-semibold [&_a.ed-btn]:text-primary-foreground [&_a.ed-btn]:no-underline";

export function RichTextEditor({
  id,
  value,
  onChange,
  labels,
  className,
  mediaCategory = "general",
  /**
   * The Visual / HTML source tabs. ON by default since changes-46 #2 — the
   * owner asked for the article editor's two tabs on every text editor, and
   * an opt-in had left the glossary topic, tool and email bodies without it.
   */
  allowHtmlMode = true,
  mode: controlledMode,
  onModeChange,
  ai,
  emailBlocks = false,
}: {
  id?: string;
  /** Stored HTML (sanitized server-side on the last save). */
  value: string;
  onChange: (html: string) => void;
  labels: RichTextLabels;
  className?: string;
  /**
   * Where an in-body image lands (ADR-066 §4). Defaulted, unlike
   * `ImageUploadField`'s: this editor is embedded in a dozen forms whose
   * bodies are prose rather than a named asset slot, and `general` is the
   * honest answer for a surface that has not said otherwise. A host that
   * knows better — the article editor — passes its own.
   */
  mediaCategory?: MediaCategory;
  allowHtmlMode?: boolean;
  /**
   * Controlled tab, for a host whose STORED data depends on it — the email
   * template's body mode decides whether the shell wraps it. Omitted, the
   * editor keeps its own state and always opens on Visual.
   */
  mode?: "visual" | "html";
  onModeChange?: (mode: "visual" | "html") => void;
  /**
   * An EMAIL body (changes-61, ADR-184): keep the email block classes and
   * badges a Visual save would otherwise drop, and draw them roughly as the
   * message will. The preview is still the true render.
   */
  emailBlocks?: boolean;
  /**
   * The writing assistant (changes-29 B1), or nothing.
   *
   * **Its PRESENCE is the availability answer** (ADR-097 #6): resolved on the
   * server by `getAiAvailability()` and passed down, so an AI-off install
   * renders no AI control and ships no AI client code into this bundle. There
   * is deliberately no `aiEnabled` boolean — a boolean invites a `disabled`
   * prop, which is the failure `ai-degradation.test.ts` exists to catch.
   */
  ai?: { config: AiAssistantConfig; labels: AiAssistantLabels };
}) {
  const t = useTranslations("admin");
  // ADR-077: inside a Field the editor is that Field's control.
  const field = useFieldContext();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  const [ownMode, setOwnMode] = React.useState<"visual" | "html">("visual");
  const mode = controlledMode ?? ownMode;
  const setMode = (next: "visual" | "html") => {
    setOwnMode(next);
    onModeChange?.(next);
  };
  // ADR-049: an image already in the library goes into a second article
  // without a second upload. Same dialog the image FIELDS use.
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [sizeError, setSizeError] = React.useState<string | null>(null);
  // The assistant's result lives here rather than in the menu, because the
  // panel that renders it is a sibling of the toolbar, not a child of it.
  const [aiResult, setAiResult] = React.useState<AiResultState>(AI_RESULT_IDLE);
  const upload = useUploadProgress<StoredImage>("/keystone/api/uploads/image");

  // The last HTML this component itself emitted. Used to tell the user
  // typing apart from the parent handing us a different document — the
  // article editor's locale switcher does the latter, and before this the
  // editor kept the previous locale's body on screen and then wrote it into
  // the new locale's draft on the next keystroke.
  // (Prose here avoids double quotes on purpose: check:phantom-deps reads a
  // quoted phrase after the word "imports" as a module specifier.)
  const emitted = React.useRef(value);

  const emit = React.useCallback(
    (html: string) => {
      emitted.current = html;
      onChange(html);
    },
    [onChange],
  );

  const editor = useEditor({
    // SSR-safe: Next renders this client component on the server first.
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        link: {
          openOnClick: false,
          autolink: true,
          // `recipient.name` is a valid domain; linked, it is no longer a
          // placeholder and the reader gets the braces.
          shouldAutoLink: (url) => !isEmailVariableName(url),
          defaultProtocol: "https",
          protocols: ["http", "https", "mailto"],
        },
      }),
      Image.configure({ inline: false, allowBase64: false }),
      // Resizing off: it persists column widths as inline styles, which
      // sanitizeRichText strips on save (security.md #8). Handles that do
      // nothing after a reload are worse than no handles.
      TableKit.configure({ table: { resizable: false } }),
      ...EDITORIAL_EXTENSIONS,
      ...(emailBlocks ? EMAIL_EXTENSIONS : []),
      Placeholder.configure({ placeholder: labels.placeholder }),
    ],
    content: value,
    editorProps: {
      attributes: {
        class: emailBlocks ? `${EDITOR_CANVAS} ${EMAIL_CANVAS}` : EDITOR_CANVAS,
      },
    },
    onUpdate: ({ editor: e }) => emit(e.getHTML()),
    // Toolbar active states live on the editor, not React state — nudge a
    // re-render on selection/transaction so aria-pressed stays honest.
    onSelectionUpdate: () => force(),
    onTransaction: () => force(),
  });

  // Adopt a document the parent swapped underneath us (locale switch,
  // server refresh). Never fires for the user's own typing, because
  // `emitted` already holds exactly what they produced.
  React.useEffect(() => {
    if (!editor || value === emitted.current) return;
    emitted.current = value;
    editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);

  // ADR-077 — the editable surface is a div, which a label's `for` cannot
  // name, so it is named by the Field's label id instead, and carries the
  // Field's state like any other control. Set on the DOM node rather than
  // through editorProps: those are read when ProseMirror builds its props,
  // so a field turning invalid without a transaction would not reach them.
  // ProseMirror leaves attributes it did not set alone.
  const fieldId = id ?? field?.controlId;
  const labelledBy = field?.labelId;
  const describedBy = field?.describedBy;
  const invalid = field?.invalid ?? false;
  const required = field?.required ?? false;
  React.useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    const set = (name: string, next: string | undefined) =>
      next === undefined ? dom.removeAttribute(name) : dom.setAttribute(name, next);
    set("role", "textbox");
    set("aria-multiline", "true");
    set("id", fieldId);
    set("aria-labelledby", labelledBy);
    set("aria-describedby", describedBy);
    set("aria-invalid", invalid ? "true" : undefined);
    set("aria-required", required ? "true" : undefined);
  }, [editor, fieldId, labelledBy, describedBy, invalid, required]);

  const setLink = (e: Editor) => {
    const previous = e.getAttributes("link").href as string | undefined;
    const url = window.prompt(labels.linkPrompt, previous ?? "https://");
    if (url === null) return;
    if (url.trim() === "") {
      e.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    e.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  };

  const insertVideo = (e: Editor) => {
    const input = window.prompt(labels.videoPrompt, "https://");
    if (input === null || input.trim() === "") return;
    // Whitelist parse BEFORE anything reaches the document: an unrecognised
    // host never becomes a node, so the sanitizer's own re-derivation on
    // save is a backstop rather than the only check.
    const parsed = parseVideoUrl(input);
    if (!parsed) {
      window.alert(labels.videoInvalid);
      return;
    }
    e.chain()
      .focus()
      .insertContent({
        type: "videoEmbed",
        attrs: { src: parsed.embedUrl, title: `${parsed.provider} ${parsed.videoId}` },
      })
      .run();
  };

  const insertImage = async (e: Editor, file: File | undefined) => {
    if (!file) return;
    // ADR-049 §6 — refuse an oversized file before spending the upload,
    // with the real numbers. @repo/core still decides server-side.
    const oversize = describeOversizeFile(file, t);
    if (oversize) {
      setSizeError(oversize);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setSizeError(null);
    const stored = await upload.upload(file, { purpose: "content", category: mediaCategory });
    if (stored) e.chain().focus().setImage({ src: stored.url, alt: file.name }).run();
    if (fileRef.current) fileRef.current.value = "";
  };

  if (!editor) {
    return (
      <div
        className={cn("min-h-96 rounded-md border border-input bg-background", className)}
        aria-busy
      />
    );
  }

  const can = editor.can();

  const setValueMark = (name: string, next: string | null) => {
    const chain = editor.chain().focus();
    (next === null ? chain.unsetMark(name) : chain.setMark(name, { value: next })).run();
  };

  const setAlign = (next: EditorAlignment | null) => {
    let chain = editor.chain().focus();
    for (const type of ALIGNABLE_TYPES) chain = chain.updateAttributes(type, { align: next });
    chain.run();
  };

  const activeBlockLabel = editor.isActive("heading", { level: 2 })
    ? labels.heading2
    : editor.isActive("heading", { level: 3 })
      ? labels.heading3
      : editor.isActive("heading", { level: 4 })
        ? labels.heading4
        : labels.paragraph;

  return (
    <div
      data-invalid={invalid || undefined}
      className={cn(
        // `min-w-0` is what keeps the editor from widening its grid track:
        // a flex/grid child defaults to min-width:auto, i.e. "as wide as my
        // widest unbreakable content", which is how one pasted URL used to
        // push the whole page into horizontal scroll.
        //
        // The frame is the Textarea recipe (tokens.md §1.5, §6.14; audit
        // F-04): the Input's radius, border and page background, the 2px
        // ring at a 2px offset, and the Input's invalid state. No `dark:`
        // class — the dark tokens already carry the dark surface.
        "flex min-w-0 flex-col overflow-hidden rounded-md border border-input bg-background transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background data-invalid:border-destructive data-invalid:ring-2 data-invalid:ring-destructive/20",
        className,
      )}
    >
      {allowHtmlMode && (
        <div className="flex items-center gap-1 border-b bg-muted/50 p-1">
          <Button
            type="button"
            variant={mode === "visual" ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={mode === "visual"}
            onClick={() => {
              if (mode === "visual") return;
              // The textarea is the source of truth while in HTML mode, so
              // hand its text back to ProseMirror on the way out.
              editor.commands.setContent(value, { emitUpdate: false });
              emitted.current = value;
              setMode("visual");
            }}
          >
            <Eye data-icon="inline-start" aria-hidden />
            {labels.modeVisual}
          </Button>
          <Button
            type="button"
            variant={mode === "html" ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={mode === "html"}
            onClick={() => {
              if (mode === "html") return;
              emit(editor.getHTML());
              setMode("html");
            }}
          >
            <Code2 data-icon="inline-start" aria-hidden />
            {labels.modeHtml}
          </Button>
          {mode === "html" && (
            <span className="ms-auto pe-1 text-xs text-muted-foreground">{labels.htmlHint}</span>
          )}
        </div>
      )}

      {mode === "html" ? (
        <Textarea
          id={id}
          value={value}
          rows={24}
          spellCheck={false}
          // ADR-044 #6's stated exception: a control whose VALUE is code the
          // admin reads character by character keeps a fixed-width face.
          // The frame draws the focus and invalid rings for both modes.
          className="min-h-96 resize-y rounded-none border-0 font-mono text-xs whitespace-pre focus-visible:ring-0 focus-visible:ring-offset-0 aria-invalid:ring-0"
          onChange={(e) => emit(e.target.value)}
        />
      ) : (
        <>
          <div
            role="toolbar"
            aria-label={labels.toolbar}
            className="flex flex-wrap items-center gap-0.5 border-b bg-muted/30 p-1"
          >
            <ToolbarButton
              label={labels.undo}
              disabled={!can.undo()}
              onClick={() => editor.chain().focus().undo().run()}
            >
              <Undo2 aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              label={labels.redo}
              disabled={!can.redo()}
              onClick={() => editor.chain().focus().redo().run()}
            >
              <Redo2 aria-hidden />
            </ToolbarButton>
            <Separator orientation="vertical" className="mx-1 h-5!" />

            {/* Block type */}
            <ToolbarMenu
              label={labels.blockType}
              icon={<span className="text-xs font-medium">{activeBlockLabel}</span>}
            >
              <DropdownMenuItem onClick={() => editor.chain().focus().setParagraph().run()}>
                <Pilcrow aria-hidden />
                {labels.paragraph}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => editor.chain().focus().setHeading({ level: 2 }).run()}
              >
                <Heading2 aria-hidden />
                {labels.heading2}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => editor.chain().focus().setHeading({ level: 3 }).run()}
              >
                <Heading3 aria-hidden />
                {labels.heading3}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => editor.chain().focus().setHeading({ level: 4 }).run()}
              >
                <Heading4 aria-hidden />
                {labels.heading4}
              </DropdownMenuItem>
            </ToolbarMenu>

            {/* Family */}
            <ToolbarMenu label={labels.fontFamily} icon={<Type aria-hidden className="size-4" />}>
              <DropdownMenuItem onClick={() => setValueMark("fontFamily", null)}>
                {labels.defaultOption}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {EDITOR_FONTS.map((font) => (
                <DropdownMenuItem
                  key={font}
                  onClick={() => setValueMark("fontFamily", font)}
                  className={`ed-ff-${font}`}
                >
                  {labels.fonts[font]}
                </DropdownMenuItem>
              ))}
            </ToolbarMenu>

            {/* Size */}
            <ToolbarMenu
              label={labels.fontSize}
              icon={<span className="text-xs font-medium">{labels.fontSize}</span>}
            >
              <DropdownMenuItem onClick={() => setValueMark("fontSize", null)}>
                {labels.defaultOption}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {EDITOR_SIZES.map((size) => (
                <DropdownMenuItem key={size} onClick={() => setValueMark("fontSize", size)}>
                  {labels.sizes[size]}
                </DropdownMenuItem>
              ))}
            </ToolbarMenu>
            <Separator orientation="vertical" className="mx-1 h-5!" />

            <ToolbarButton
              label={labels.bold}
              active={editor.isActive("bold")}
              onClick={() => editor.chain().focus().toggleBold().run()}
            >
              <Bold aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              label={labels.italic}
              active={editor.isActive("italic")}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            >
              <Italic aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              label={labels.underline}
              active={editor.isActive("underline")}
              onClick={() => editor.chain().focus().toggleUnderline().run()}
            >
              <Underline aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              label={labels.strike}
              active={editor.isActive("strike")}
              onClick={() => editor.chain().focus().toggleStrike().run()}
            >
              <Strikethrough aria-hidden />
            </ToolbarButton>

            {/* Tone + highlight — semantic swatches, not a colour picker.
                Both resolve to theme tokens (ADR-046), so a re-brand
                re-colours every article ever written. */}
            <ToolbarMenu
              label={labels.textColor}
              icon={<Baseline aria-hidden className="size-4" />}
            >
              <DropdownMenuItem onClick={() => setValueMark("textTone", null)}>
                {labels.defaultOption}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {EDITOR_TONES.map((tone) => (
                <DropdownMenuItem key={tone} onClick={() => setValueMark("textTone", tone)}>
                  <span
                    aria-hidden
                    className={cn("size-3 shrink-0 rounded-full", TONE_SWATCH[tone])}
                  />
                  {labels.tones[tone]}
                </DropdownMenuItem>
              ))}
            </ToolbarMenu>
            <ToolbarMenu
              label={labels.highlight}
              icon={<Highlighter aria-hidden className="size-4" />}
            >
              <DropdownMenuItem onClick={() => setValueMark("highlightTone", null)}>
                {labels.defaultOption}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {EDITOR_TONES.map((tone) => (
                <DropdownMenuItem key={tone} onClick={() => setValueMark("highlightTone", tone)}>
                  <span
                    aria-hidden
                    className={cn("size-3 shrink-0 rounded-sm", TONE_SWATCH[tone])}
                  />
                  {labels.tones[tone]}
                </DropdownMenuItem>
              ))}
            </ToolbarMenu>

            {/* Alignment */}
            <ToolbarMenu label={labels.align} icon={<AlignLeft aria-hidden className="size-4" />}>
              {EDITOR_ALIGNMENTS.map((alignment) => {
                const Icon = ALIGN_ICON[alignment];
                return (
                  <DropdownMenuItem key={alignment} onClick={() => setAlign(alignment)}>
                    <Icon aria-hidden />
                    {labels.alignments[alignment]}
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setAlign(null)}>
                {labels.defaultOption}
              </DropdownMenuItem>
            </ToolbarMenu>
            <Separator orientation="vertical" className="mx-1 h-5!" />

            <ToolbarButton
              label={labels.bulletList}
              active={editor.isActive("bulletList")}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
            >
              <List aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              label={labels.orderedList}
              active={editor.isActive("orderedList")}
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
            >
              <ListOrdered aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              label={labels.blockquote}
              active={editor.isActive("blockquote")}
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
            >
              <Quote aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              label={labels.codeBlock}
              active={editor.isActive("codeBlock")}
              onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            >
              <Code aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              label={labels.horizontalRule}
              onClick={() => editor.chain().focus().setHorizontalRule().run()}
            >
              <Minus aria-hidden />
            </ToolbarButton>
            <Separator orientation="vertical" className="mx-1 h-5!" />

            <ToolbarButton
              label={labels.link}
              active={editor.isActive("link")}
              onClick={() => setLink(editor)}
            >
              <LinkIcon aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              label={labels.unlink}
              disabled={!editor.isActive("link")}
              onClick={() => editor.chain().focus().unsetLink().run()}
            >
              <Unlink aria-hidden />
            </ToolbarButton>
            {/* changes-49: ONE image button. The dialog it opens offers the
                library, a web address, and "Upload from computer" — there
                used to be an upload button and a library button side by side,
                two doors to one room. */}
            <ToolbarButton label={labels.image} onClick={() => setPickerOpen(true)}>
              <ImagePlus aria-hidden />
            </ToolbarButton>
            <ToolbarButton label={labels.video} onClick={() => insertVideo(editor)}>
              <Video aria-hidden />
            </ToolbarButton>

            {/* Table */}
            <ToolbarMenu label={labels.table} icon={<TableIcon aria-hidden className="size-4" />}>
              <DropdownMenuItem
                onClick={() =>
                  editor
                    .chain()
                    .focus()
                    .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                    .run()
                }
              >
                <TableIcon aria-hidden />
                {labels.insertTable}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!can.addRowAfter()}
                onClick={() => editor.chain().focus().addRowAfter().run()}
              >
                <Rows3 aria-hidden />
                {labels.addRowAfter}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!can.addColumnAfter()}
                onClick={() => editor.chain().focus().addColumnAfter().run()}
              >
                <Columns3 aria-hidden />
                {labels.addColumnAfter}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!can.toggleHeaderRow()}
                onClick={() => editor.chain().focus().toggleHeaderRow().run()}
              >
                {labels.toggleHeaderRow}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={!can.deleteRow()}
                onClick={() => editor.chain().focus().deleteRow().run()}
              >
                {labels.deleteRow}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={!can.deleteColumn()}
                onClick={() => editor.chain().focus().deleteColumn().run()}
              >
                {labels.deleteColumn}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={!can.deleteTable()}
                onClick={() => editor.chain().focus().deleteTable().run()}
              >
                {labels.deleteTable}
              </DropdownMenuItem>
            </ToolbarMenu>
            <Separator orientation="vertical" className="mx-1 h-5!" />

            <ToolbarButton
              label={labels.clearFormatting}
              onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
            >
              <Eraser aria-hidden />
            </ToolbarButton>

            {/* changes-29 B1. Last in the row, and present only when the host
                was given AI availability — there is nothing to grey out. */}
            {ai && (
              <>
                <Separator orientation="vertical" className="mx-1 h-5!" />
                <AiAssistantMenu
                  editor={editor}
                  config={ai.config}
                  labels={ai.labels}
                  onResult={setAiResult}
                />
              </>
            )}
          </div>

          {sizeError && (
            <p className="border-b px-3 py-2 text-xs text-destructive-interactive" role="status">
              {sizeError}
            </p>
          )}
          {upload.status !== "idle" && (
            <UploadProgress
              status={upload.status}
              progress={upload.progress}
              error={upload.error}
              fileName={upload.fileName}
              onRetry={() =>
                void upload
                  .retry()
                  .then(
                    (stored) =>
                      stored &&
                      editor
                        .chain()
                        .focus()
                        .setImage({ src: stored.url, alt: stored.fileName })
                        .run(),
                  )
              }
              className="rounded-none border-x-0 border-t-0"
            />
          )}
          {/* The scroll container of last resort. Everything above wraps or
              scrolls in place; this catches whatever still doesn't, so the
              overflow stays inside the editor instead of reaching the page. */}
          <div className="min-w-0 overflow-x-auto">
            <EditorContent editor={editor} />
          </div>
          {/* The result is a PANEL, never an auto-insert: the model suggests
              and the admin decides where the text goes (ADR-097 #4). */}
          {ai && (
            <AiResultPanel
              state={aiResult}
              labels={ai.labels}
              hasSelection={!editor.state.selection.empty}
              onInsert={(text) => {
                editor.chain().focus().insertContent(text).run();
                setAiResult(AI_RESULT_IDLE);
              }}
              onReplace={(text) => {
                editor.chain().focus().deleteSelection().insertContent(text).run();
                setAiResult(AI_RESULT_IDLE);
              }}
              onDiscard={() => setAiResult(AI_RESULT_IDLE)}
            />
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => void insertImage(editor, e.target.files?.[0])}
          />
          <MediaPickerDialog
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            purpose="content"
            category={mediaCategory}
            kinds={["IMAGE"]}
            title={labels.image}
            allowWebAddress
            onSelect={(picked) => {
              setSizeError(null);
              editor
                .chain()
                .focus()
                .setImage({ src: picked.url, alt: picked.altText ?? picked.fileName })
                .run();
            }}
          />
        </>
      )}
    </div>
  );
}
