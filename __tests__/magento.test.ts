/**
 * Tests for the Magento 2 framework resolver + XML wiring synthesizer.
 *
 * Unit tests cover detect() and the FQCN matching helpers. The end-to-end test
 * indexes a temporary Magento module layout and asserts the synthesized wiring
 * edges (preference / plugin / observer / layout block) and extracted nodes
 * (webapi route / virtualType) connect to the PHP side.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import {
  bestPhpNodeMatches,
  fqcnPathScore,
  fqcnSimpleName,
  magentoResolver,
  matchPhpNodeForFqcn,
} from '../src/resolution/frameworks/magento';
import type { ResolutionContext } from '../src/resolution/types';
import type { Node } from '../src/types';

function makeContext(overrides: Partial<ResolutionContext> = {}): ResolutionContext {
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    readFile: () => null,
    getProjectRoot: () => '/project',
    getAllFiles: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------

describe('magentoResolver.detect', () => {
  it('returns true when app/etc/di.xml exists', () => {
    const ctx = makeContext({ fileExists: (f) => f === 'app/etc/di.xml' });
    expect(magentoResolver.detect(ctx)).toBe(true);
  });

  it('returns true when bin/magento exists', () => {
    const ctx = makeContext({ fileExists: (f) => f === 'bin/magento' });
    expect(magentoResolver.detect(ctx)).toBe(true);
  });

  it('returns true via composer magento/framework dependency', () => {
    const ctx = makeContext({
      readFile: (f) =>
        f === 'composer.json'
          ? JSON.stringify({ require: { 'magento/framework': '103.0.*' } })
          : null,
    });
    expect(magentoResolver.detect(ctx)).toBe(true);
  });

  it('returns false for a non-Magento project', () => {
    const ctx = makeContext({
      readFile: (f) =>
        f === 'composer.json' ? JSON.stringify({ require: { 'laravel/framework': '^10' } }) : null,
    });
    expect(magentoResolver.detect(ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FQCN matching helpers
// ---------------------------------------------------------------------------

describe('magento FQCN helpers', () => {
  it('fqcnSimpleName takes the last backslash segment', () => {
    expect(fqcnSimpleName('Magento\\Catalog\\Api\\ProductRepositoryInterface')).toBe(
      'ProductRepositoryInterface'
    );
    expect(fqcnSimpleName('\\Vendor\\Mod\\Foo')).toBe('Foo');
  });

  it('fqcnPathScore counts trailing matching segments', () => {
    expect(
      fqcnPathScore('app/code/Vendor/Mod/Model/Foo.php', 'Vendor\\Mod\\Model\\Foo')
    ).toBe(4);
    // Only the class name lines up → score 1.
    expect(fqcnPathScore('totally/different/Foo.php', 'Vendor\\Mod\\Model\\Foo')).toBe(1);
  });

  it('bestPhpNodeMatches disambiguates same-named classes by path', () => {
    const a = { id: 'a', name: 'Foo', filePath: 'app/code/Vendor/A/Model/Foo.php' } as Node;
    const b = { id: 'b', name: 'Foo', filePath: 'app/code/Vendor/B/Model/Foo.php' } as Node;
    const best = bestPhpNodeMatches([a, b], 'Vendor\\B\\Model\\Foo');
    expect(best).toHaveLength(1);
    expect(best[0]!.id).toBe('b');
  });

  it('matchPhpNodeForFqcn REJECTS a class-name-only collision (no false edge)', () => {
    // Core FQCN, but only a coincidental custom class of the same name is indexed
    // (vendor/ not indexed). Path score is 1 → must be rejected, not matched.
    const custom = {
      id: 'x',
      name: 'Template',
      filePath: 'app/code/Acme/Shop/Block/Email/Template.php',
    } as Node;
    expect(matchPhpNodeForFqcn([custom], 'Magento\\Backend\\Block\\Template')).toBeNull();
  });

  it('matchPhpNodeForFqcn ACCEPTS a genuine namespace-tail match', () => {
    const real = {
      id: 'y',
      name: 'Template',
      filePath: 'vendor/magento/module-backend/Block/Template.php',
    } as Node;
    // tail Block/Template lines up → score 2 → accepted.
    expect(matchPhpNodeForFqcn([real], 'Magento\\Backend\\Block\\Template')?.id).toBe('y');
  });

  it('fqcnPathScore credits the Magento module-<kebab> directory convention', () => {
    // `Magento\Catalog` maps to `vendor/magento/module-catalog/` — full depth.
    expect(
      fqcnPathScore('vendor/magento/module-catalog/Model/Product.php', 'Magento\\Catalog\\Model\\Product')
    ).toBe(4);
    // Multi-word module: CatalogInventory → module-catalog-inventory.
    expect(
      fqcnPathScore(
        'vendor/magento/module-catalog-inventory/Model/Stock.php',
        'Magento\\CatalogInventory\\Model\\Stock'
      )
    ).toBe(4);
    // Framework is a plain dir (not module-*).
    expect(
      fqcnPathScore('vendor/magento/framework/View/Element/Template.php', 'Magento\\Framework\\View\\Element\\Template')
    ).toBe(5);
  });

  it('matchPhpNodeForFqcn breaks a core-vs-custom tie toward the real core class', () => {
    // Both end in Model/Product; only the module-<kebab> credit separates them.
    const custom = { id: 'c', name: 'Product', filePath: 'app/code/Acme/Shop/Model/Product.php' } as Node;
    const core = {
      id: 'core',
      name: 'Product',
      filePath: 'vendor/magento/module-catalog/Model/Product.php',
    } as Node;
    expect(matchPhpNodeForFqcn([custom, core], 'Magento\\Catalog\\Model\\Product')?.id).toBe('core');
  });

  it('matchPhpNodeForFqcn REJECTS when only a wrong-vendor same-name class exists', () => {
    // Core Magento\AdobeIms\Model\Config not indexed; a coincidental custom Config
    // must NOT be wired (vendor-root "magento" absent from its path).
    const custom = {
      id: 'x',
      name: 'Config',
      filePath: 'app/code/Mageplaza/Shopbybrand/Plugin/Model/Config.php',
    } as Node;
    expect(matchPhpNodeForFqcn([custom], 'Magento\\AdobeIms\\Model\\Config')).toBeNull();
  });

  it('matchPhpNodeForFqcn disambiguates two vendor-internal same-name classes', () => {
    const a = { id: 'a', name: 'Data', filePath: 'vendor/magento/framework/Config/Data.php' } as Node;
    const b = { id: 'b', name: 'Data', filePath: 'vendor/magento/framework/App/Config/Data.php' } as Node;
    expect(matchPhpNodeForFqcn([a, b], 'Magento\\Framework\\Config\\Data')?.id).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// End-to-end integration
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Magento end-to-end — XML wiring connects to PHP', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('synthesizes preference/plugin/observer/layout edges + webapi/virtualType nodes', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-magento-'));

    const write = (rel: string, content: string) => {
      const full = path.join(tmpDir!, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    };

    // Detection signals
    write('composer.json', JSON.stringify({ require: { 'magento/framework': '103.0.*' } }));
    write('app/etc/di.xml', '<?xml version="1.0"?><config></config>\n');

    const NS = 'Acme\\Shop';
    const mod = 'app/code/Acme/Shop';

    // --- PHP side ---------------------------------------------------------
    write(
      `${mod}/Api/StockManagerInterface.php`,
      `<?php\nnamespace ${NS}\\Api;\ninterface StockManagerInterface {\n  public function reserve($sku);\n}\n`
    );
    write(
      `${mod}/Model/StockManager.php`,
      `<?php\nnamespace ${NS}\\Model;\nuse ${NS}\\Api\\StockManagerInterface;\nclass StockManager implements StockManagerInterface {\n  public function reserve($sku) { return true; }\n}\n`
    );
    write(
      `${mod}/Model/Original.php`,
      `<?php\nnamespace ${NS}\\Model;\nclass Original {\n  public function getPrice() { return 10; }\n}\n`
    );
    write(
      `${mod}/Plugin/PricePlugin.php`,
      `<?php\nnamespace ${NS}\\Plugin;\nclass PricePlugin {\n  public function afterGetPrice($subject, $result) { return $result * 2; }\n}\n`
    );
    write(
      `${mod}/Observer/OrderObserver.php`,
      `<?php\nnamespace ${NS}\\Observer;\nclass OrderObserver {\n  public function execute($observer) { }\n}\n`
    );
    write(
      `${mod}/Block/Listing.php`,
      `<?php\nnamespace ${NS}\\Block;\nclass Listing {\n  public function getItems() { return []; }\n}\n`
    );

    // --- XML wiring -------------------------------------------------------
    write(
      `${mod}/etc/di.xml`,
      `<?xml version="1.0"?>
<config>
  <preference for="${NS}\\Api\\StockManagerInterface" type="${NS}\\Model\\StockManager"/>
  <type name="${NS}\\Model\\Original">
    <plugin name="acme_price" type="${NS}\\Plugin\\PricePlugin" sortOrder="10"/>
  </type>
  <virtualType name="${NS}\\Model\\VirtualStock" type="${NS}\\Model\\StockManager"/>
</config>
`
    );
    write(
      `${mod}/etc/events.xml`,
      `<?xml version="1.0"?>
<config>
  <event name="sales_order_place_after">
    <observer name="acme_order" instance="${NS}\\Observer\\OrderObserver"/>
  </event>
</config>
`
    );
    write(
      `${mod}/etc/webapi.xml`,
      `<?xml version="1.0"?>
<routes>
  <route url="/V1/stock/:sku" method="GET">
    <service class="${NS}\\Api\\StockManagerInterface" method="reserve"/>
  </route>
</routes>
`
    );
    write(
      `${mod}/view/frontend/layout/catalog_product_view.xml`,
      `<?xml version="1.0"?>
<page>
  <body>
    <referenceContainer name="content">
      <block class="${NS}\\Block\\Listing" name="acme.listing"/>
    </referenceContainer>
  </body>
</page>
`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const byKind = (k: Node['kind']) => cg.getNodesByKind(k);
    const find = (k: Node['kind'], name: string) => byKind(k).find((n) => n.name === name);

    // preference: interface → concrete class (overrides)
    const iface = find('interface', 'StockManagerInterface');
    expect(iface).toBeDefined();
    const impl = find('class', 'StockManager');
    expect(impl).toBeDefined();
    const prefEdge = cg
      .getOutgoingEdges(iface!.id)
      .find((e) => (e.metadata as any)?.synthesizedBy === 'magento-preference');
    expect(prefEdge).toBeDefined();
    expect(prefEdge!.target).toBe(impl!.id);

    // plugin: Original::getPrice → PricePlugin::afterGetPrice
    const getPrice = byKind('method').find(
      (n) => n.name === 'getPrice'
    );
    const afterGetPrice = byKind('method').find((n) => n.name === 'afterGetPrice');
    expect(getPrice).toBeDefined();
    expect(afterGetPrice).toBeDefined();
    const pluginEdge = cg
      .getOutgoingEdges(getPrice!.id)
      .find((e) => (e.metadata as any)?.synthesizedBy === 'magento-plugin');
    expect(pluginEdge).toBeDefined();
    expect(pluginEdge!.target).toBe(afterGetPrice!.id);

    // observer: events.xml file → OrderObserver::execute
    const eventsFile = byKind('file').find((n) => n.filePath.endsWith('events.xml'));
    expect(eventsFile).toBeDefined();
    const obsEdge = cg
      .getOutgoingEdges(eventsFile!.id)
      .find((e) => (e.metadata as any)?.synthesizedBy === 'magento-observer');
    expect(obsEdge).toBeDefined();

    // layout block: layout file → Listing class
    const layoutFile = byKind('file').find((n) =>
      n.filePath.endsWith('catalog_product_view.xml')
    );
    expect(layoutFile).toBeDefined();
    const blockEdge = cg
      .getOutgoingEdges(layoutFile!.id)
      .find((e) => (e.metadata as any)?.synthesizedBy === 'magento-layout-block');
    expect(blockEdge).toBeDefined();
    const listing = find('class', 'Listing');
    expect(blockEdge!.target).toBe(listing!.id);

    // webapi route node exists and links to the service method
    const routes = byKind('route');
    const webRoute = routes.find((n) => n.name.includes('/V1/stock'));
    expect(webRoute).toBeDefined();
    expect(cg.getOutgoingEdges(webRoute!.id).length).toBeGreaterThan(0);

    // virtualType node exists
    const virtual = find('class', 'VirtualStock');
    expect(virtual).toBeDefined();

    cg.close();
  });
});
