# Language coverage and desktop performance improvements

## Language coverage

The desktop language engine now batches dynamically inserted UI into one animation-frame pass rather than translating each MutationObserver record synchronously. It translates visible text nodes and common accessibility/UI attributes (`placeholder`, `title`, `aria-label`, `aria-description`, and `alt`) across the desktop shell, including content rendered after a settings page, menu, toast, or dialog opens. Translation source strings are cached during a language session to avoid repeatedly scanning every locale dictionary for each node.

The selected language is still limited to the strings present in the shipped dictionaries. Any text absent from a translation dictionary falls back to its original English string; fully translated coverage requires each locale's dictionary to include the relevant source strings. Code blocks, scripts, styles, and textareas are intentionally excluded to avoid corrupting code or user-entered content.

## CPU and rendering improvements

Dragging a desktop window now temporarily disables backdrop blur, descendant animations, and other expensive glass effects on the moving window and other windows. The dragged window uses layout/paint containment and a lighter shadow while moving. Wallpaper blur is also temporarily disabled during the drag. These styles are removed when the pointer is released, restoring the normal appearance.

The i18n MutationObserver now batches added nodes and skips nested roots already covered by a queued ancestor. This avoids repeated subtree traversals during UI updates.

## Verification

Run from the repository root:

```sh
npm run check
npm test
```

These checks validate JavaScript syntax and the existing automated command/import tests. CPU improvements should additionally be measured in the packaged Windows app with Electron DevTools Performance/CPU profiling on the target machine; exact CPU percentages depend on GPU acceleration, display scaling, wallpaper, and hardware.
