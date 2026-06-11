/**
 * Magento 2 Framework Resolver
 *
 * Magento is an XML-wired framework: the "linho hồn" of how classes connect —
 * dependency injection (`di.xml`), events (`events.xml`), REST/SOAP routing
 * (`webapi.xml`), frontend/admin routing (`routes.xml`), and view layout
 * (`*.xml` under `view/.../layout`) — lives in XML, NOT in PHP. Static
 * tree-sitter parsing only sees the PHP side, so every wiring boundary breaks:
 * "which concrete class actually runs for this interface?", "what plugins
 * intercept this method?", "which observer handles this event?" are invisible.
 *
 * This resolver bridges those boundaries. It runs in two places, mirroring the
 * MyBatis design (extractor + synthesizer):
 *
 *  1. `extract()` here — creates NEW symbol nodes that XML introduces:
 *       - `<route>` REST/SOAP endpoints from `webapi.xml`,
 *       - `<route>` frontName routes from `routes.xml`,
 *       - virtual-type `class` nodes from `di.xml` `<virtualType>`,
 *     plus unresolved references from those nodes to their PHP handlers, which
 *     `resolve()` links to the indexed class/method.
 *
 *  2. `magentoXmlEdges()` (in `callback-synthesizer.ts`) — synthesizes DIRECT
 *     PHP↔PHP edges that don't introduce a new symbol:
 *       - preference  → interface `overrides` concrete class,
 *       - plugin      → target method `references` before/after/around method,
 *       - observer    → events.xml `references` observer class,
 *       - layout block→ layout xml `references` block class.
 *
 * ## Resolution semantics — "link all candidates"
 *
 * Magento resolves a preference/plugin by AREA (global / frontend / adminhtml)
 * and module load order. We deliberately do NOT simulate that: every
 * declaration becomes an edge, tagged with `metadata.area` so the consumer can
 * filter. This is robust and matches the "show me every candidate that could
 * override X" mental model.
 *
 * ## Degrades gracefully when core (vendor/) is not indexed
 *
 * Magento gitignores `vendor/`, so codegraph skips it by default and the core
 * interfaces a preference/plugin targets are often absent from the graph. When
 * that happens the reference stays unresolved (still searchable by FQCN) and
 * the custom-side links still form. Index `vendor/` to connect custom → core.
 *
 * ## Name matching
 *
 * PHP nodes store `qualified_name` WITHOUT the namespace (just `ClassName` or
 * `ClassName::method`), and Magento's PSR-4 maps namespaces to non-mirrored
 * paths (`Magento\Catalog` → `vendor/magento/module-catalog`). So we match a
 * FQCN by its simple (last) name and disambiguate by the longest file-path
 * suffix that mirrors the FQCN's trailing namespace segments. See
 * `bestPhpNodeMatch`.
 */

import { generateNodeId } from '../../extraction/tree-sitter-helpers';
import { Node } from '../../types';
import { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';

// ---------------------------------------------------------------------------
// Shared string / matching helpers (also used by the synthesizer)
// ---------------------------------------------------------------------------

/** Strip a leading backslash and surrounding whitespace from a FQCN. */
export function cleanFqcn(fqcn: string): string {
  return fqcn.replace(/^\\+/, '').trim();
}

/** Last `\`-separated segment of a FQCN, e.g. `A\B\Foo` → `Foo`. */
export function fqcnSimpleName(fqcn: string): string {
  const clean = cleanFqcn(fqcn);
  const parts = clean.split('\\');
  return parts[parts.length - 1] ?? clean;
}

/**
 * Magento module-directory form of a namespace segment:
 * `Catalog` → `module-catalog`, `CatalogInventory` → `module-catalog-inventory`.
 * Magento's composer PSR-4 maps `Vendor\Module` → `vendor/<vendor>/module-<kebab>/`,
 * so the distinguishing namespace segment never appears verbatim on the path.
 */
function moduleDirName(seg: string): string {
  const kebab = seg
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
  return 'module-' + kebab;
}

/**
 * Whether a namespace segment matches a path segment under Magento's PSR-4
 * conventions: exact (case-insensitive — `Magento`→`magento`, `Framework`→
 * `framework`) OR the `module-<kebab>` mapping (`Catalog`→`module-catalog`).
 */
function segmentMatches(nsSeg: string, pathSeg: string): boolean {
  const ns = nsSeg.toLowerCase();
  const p = pathSeg.toLowerCase();
  return p === ns || p === moduleDirName(nsSeg);
}

/**
 * Score how well a file path matches a FQCN: the number of trailing namespace
 * segments that also appear, in order, as the path's trailing directory/file
 * segments. `Vendor\Mod\Model\Foo` against `app/code/Vendor/Mod/Model/Foo.php`
 * scores 4. Matching is Magento-PSR-4-aware: a segment also matches its
 * `module-<kebab>` directory (`Magento\Catalog\Model\Product` scores the FULL
 * depth against `vendor/magento/module-catalog/Model/Product.php`). Without this
 * the distinguishing `Catalog`/`Sales`/`Config` segment never matched the
 * `module-*` dir, so same-named classes tied at the shared tail and resolution
 * picked an arbitrary one. Returns 0 when only the class name lines up.
 */
export function fqcnPathScore(filePath: string, fqcn: string): number {
  const nsParts = cleanFqcn(fqcn).split('\\').filter(Boolean);
  if (nsParts.length === 0) return 0;
  // Path segments without extension on the final one.
  const pathParts = filePath.replace(/\.[^./]+$/, '').split('/').filter(Boolean);
  let score = 0;
  for (let i = 1; i <= Math.min(nsParts.length, pathParts.length); i++) {
    if (segmentMatches(nsParts[nsParts.length - i]!, pathParts[pathParts.length - i]!)) score++;
    else break;
  }
  return score;
}

/**
 * Pick the best-matching node for a FQCN from candidates that already share the
 * simple name. Prefers the highest path-suffix score; returns all top-scoring
 * nodes (usually one) so callers can honor "link all candidates" on a tie.
 */
export function bestPhpNodeMatches(candidates: Node[], fqcn: string): Node[] {
  if (candidates.length <= 1) return candidates;
  let best = -1;
  const scored = candidates.map((n) => {
    const s = fqcnPathScore(n.filePath, fqcn);
    if (s > best) best = s;
    return { n, s };
  });
  return scored.filter((x) => x.s === best).map((x) => x.n);
}

/**
 * Resolve a FQCN to the single best PHP node among same-named candidates,
 * REJECTING coincidental class-name collisions. PHP `qualified_name` carries no
 * namespace, so a FQCN like `Magento\Backend\Block\Template` would otherwise
 * match an unrelated custom `Acme\…\Email\Template` purely by class name. Three
 * gates, in order:
 *
 *  1. **path-score ≥ minScore** (≥2 for multi-segment FQCNs): the chosen path
 *     must mirror at least the class name + its parent segment.
 *  2. **vendor-root consistency**: the FQCN's first (vendor) segment must appear
 *     as a path segment of the chosen file — so a `Magento\…` ref can never land
 *     on an `app/code/Vendor\…` class of the same name when the real core target
 *     isn't indexed (emit no edge instead of a wrong one).
 *  3. **highest score wins, ties broken deterministically by path** — never the
 *     arbitrary DB order, which previously picked the wrong same-named class
 *     under Magento's `module-<name>` directory convention.
 *
 * Returns null when nothing clears the bar — a wrong edge is worse than none.
 */
export function matchPhpNodeForFqcn(candidates: Node[], fqcn: string): Node | null {
  if (candidates.length === 0) return null;
  const parts = cleanFqcn(fqcn).split('\\').filter(Boolean);
  const depth = parts.length;
  const minScore = depth >= 2 ? 2 : 1;
  const vendorRoot = parts[0]?.toLowerCase();

  const ranked = candidates
    .map((n) => ({ n, s: fqcnPathScore(n.filePath, fqcn) }))
    .filter((x) => x.s >= minScore)
    .filter((x) => {
      if (depth < 2 || !vendorRoot) return true;
      const segs = x.n.filePath.toLowerCase().replace(/\.[^./]+$/, '').split('/');
      return segs.includes(vendorRoot);
    })
    .sort((a, b) =>
      b.s - a.s || (a.n.filePath < b.n.filePath ? -1 : a.n.filePath > b.n.filePath ? 1 : 0)
    );

  return ranked[0]?.n ?? null;
}

/** 1-indexed line number of a byte offset in `content`. */
function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** The file node id MyBatisExtractor (the default .xml extractor) created. */
export function xmlFileNodeId(filePath: string): string {
  return generateNodeId(filePath, 'file', filePath, 1);
}

/** Read an attribute value from an opening-tag attribute string. */
function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// File-kind detection
// ---------------------------------------------------------------------------

function basename(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

/** Is this a layout XML (under a `view/.../layout/` or `page_layout/` dir)? */
function isLayoutXml(filePath: string): boolean {
  return /\/view\/[^/]+\/(layout|page_layout|ui_component)\/[^/]+\.xml$/.test(filePath);
}

// ---------------------------------------------------------------------------
// di.xml — virtualType node extraction (preference/plugin handled by synthesizer)
// ---------------------------------------------------------------------------

function extractVirtualTypes(filePath: string, content: string): {
  nodes: Node[];
  references: UnresolvedRef[];
} {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();

  // <virtualType name="..." type="..."> — `type` is the base class it extends.
  const re = /<virtualType\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const attrs = m[1] ?? '';
    const name = attr(attrs, 'name');
    if (!name) continue;
    const base = attr(attrs, 'type');
    const line = lineAt(content, m.index);
    const node: Node = {
      id: generateNodeId(filePath, 'class', name, line),
      kind: 'class',
      name: fqcnSimpleName(name),
      qualifiedName: name,
      filePath,
      language: 'xml',
      signature: base ? `virtualType : ${base}` : 'virtualType',
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      docstring: 'Magento DI virtualType',
      isAbstract: true,
      updatedAt: now,
    };
    nodes.push(node);
    if (base) {
      references.push({
        fromNodeId: node.id,
        referenceName: base,
        referenceKind: 'extends',
        line,
        column: 0,
        filePath,
        language: 'xml',
      });
    }
  }
  return { nodes, references };
}

// ---------------------------------------------------------------------------
// webapi.xml — REST/SOAP route nodes → service Class::method
// ---------------------------------------------------------------------------

function extractWebapi(filePath: string, content: string): {
  nodes: Node[];
  references: UnresolvedRef[];
} {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();

  // <route url="/V1/products/:sku" method="GET"> <service class="..." method="..."/> </route>
  const re = /<route\b([^>]*)>([\s\S]*?)<\/route>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const routeAttrs = m[1] ?? '';
    const body = m[2] ?? '';
    const url = attr(routeAttrs, 'url');
    const httpMethod = attr(routeAttrs, 'method');
    if (!url) continue;
    const line = lineAt(content, m.index);
    const routeNode: Node = {
      id: generateNodeId(filePath, 'route', `${httpMethod ?? 'ANY'} ${url}`, line),
      kind: 'route',
      name: `${httpMethod ?? 'ANY'} ${url}`,
      qualifiedName: `${filePath}::${httpMethod ?? 'ANY'} ${url}`,
      filePath,
      language: 'xml',
      signature: 'webapi',
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      updatedAt: now,
    };
    nodes.push(routeNode);

    const svc = /<service\b([^>]*)\/?>/.exec(body);
    if (svc) {
      const cls = attr(svc[1] ?? '', 'class');
      const method = attr(svc[1] ?? '', 'method');
      if (cls) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: method ? `${cls}::${method}` : cls,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'xml',
        });
      }
    }
  }
  return { nodes, references };
}

// ---------------------------------------------------------------------------
// routes.xml — frontName route nodes (frontend / adminhtml)
// ---------------------------------------------------------------------------

function extractRoutes(filePath: string, content: string): {
  nodes: Node[];
  references: UnresolvedRef[];
} {
  const nodes: Node[] = [];
  const now = Date.now();
  // Area is the parent dir of etc: etc/frontend/routes.xml or etc/adminhtml/routes.xml
  const area = /\/etc\/([^/]+)\/routes\.xml$/.exec(filePath)?.[1] ?? 'frontend';

  // <route id="catalog" frontName="catalog"> <module name="Magento_Catalog"/> </route>
  const re = /<route\b([^>]*)>([\s\S]*?)<\/route>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const routeAttrs = m[1] ?? '';
    const id = attr(routeAttrs, 'id');
    const frontName = attr(routeAttrs, 'frontName');
    if (!id) continue;
    const line = lineAt(content, m.index);
    const moduleName = /<module\b[^>]*\bname\s*=\s*"([^"]+)"/.exec(m[2] ?? '')?.[1] ?? null;
    nodes.push({
      id: generateNodeId(filePath, 'route', `${area}:${id}`, line),
      kind: 'route',
      name: `${area}/${frontName ?? id}`,
      qualifiedName: `${filePath}::${area}:${id}`,
      filePath,
      language: 'xml',
      signature: moduleName ? `route → ${moduleName}` : 'route',
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      docstring: moduleName ? `Magento ${area} route for ${moduleName}` : undefined,
      updatedAt: now,
    });
  }
  return { nodes, references: [] };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a FQCN (optionally `FQCN::method`) to the best indexed PHP node.
 * Honors "link all candidates" only for ties; returns the single best match
 * for the resolver pipeline (which is 1 ref → 1 target).
 */
function resolveFqcnRef(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = ref.referenceName;
  const methodSplit = name.split('::');
  const classFqcn = methodSplit[0]!;
  const methodName = methodSplit[1];

  const simple = fqcnSimpleName(classFqcn);
  const byName = context.getNodesByName(simple);
  const classNodes = byName.filter(
    (n) => n.kind === 'class' || n.kind === 'interface' || n.kind === 'trait'
  );
  if (classNodes.length === 0) return null;

  const cls = matchPhpNodeForFqcn(classNodes, classFqcn);
  if (!cls) return null;

  if (methodName) {
    const method = context
      .getNodesInFile(cls.filePath)
      .find((n) => n.kind === 'method' && n.name === methodName);
    if (method) {
      return { original: ref, targetNodeId: method.id, confidence: 0.9, resolvedBy: 'framework' };
    }
  }
  return { original: ref, targetNodeId: cls.id, confidence: 0.8, resolvedBy: 'framework' };
}

export const magentoResolver: FrameworkResolver = {
  name: 'magento',
  languages: ['php', 'xml'],

  // Magento wiring refs are FQCNs (`Vendor\Module\Model\Foo`) or `FQCN::method`
  // and name no declared symbol verbatim (qualified_name has no namespace), so
  // resolveOne's pre-filter would drop them. Claim FQCN-shaped names.
  claimsReference(name: string): boolean {
    return name.includes('\\') || /^[A-Za-z_]\w*::\w+$/.test(name);
  },

  detect(context: ResolutionContext): boolean {
    if (context.fileExists('app/etc/di.xml') || context.fileExists('bin/magento')) return true;
    const composer = context.readFile('composer.json');
    if (composer) {
      try {
        const json = JSON.parse(composer) as {
          require?: Record<string, string>;
          'require-dev'?: Record<string, string>;
        };
        const deps = { ...json.require, ...(json['require-dev'] ?? {}) };
        if (Object.keys(deps).some((k) => k === 'magento/framework' || k.startsWith('magento/'))) {
          return true;
        }
      } catch {
        // ignore malformed composer.json
      }
    }
    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const name = ref.referenceName;
    if (name.includes('\\') || /^[A-Za-z_]\w*::\w+$/.test(name)) {
      return resolveFqcnRef(ref, context);
    }
    return null;
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    const base = basename(filePath);
    if (base === 'di.xml') return extractVirtualTypes(filePath, content);
    if (base === 'webapi.xml') return extractWebapi(filePath, content);
    if (base === 'routes.xml') return extractRoutes(filePath, content);
    return { nodes: [], references: [] };
  },
};

// Re-export the layout detector for the synthesizer.
export { isLayoutXml };
