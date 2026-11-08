// The things a person does in a clip, done the way a person does them: the pointer travels, the keys come one by one. Slow motion makes
// every pause, every travel and every key longer by the same factor, so that a viewer can read what happens.
import { scaleMs } from './timeline.mjs';
import { withPersona } from './scene.mjs';

/** Draws a frame around a part of the screen (the page side of Ui.spot). */
function addSpot(frame) {
  const element = globalThis.document.createElement('div');
  element.className = 'clips-spot';
  Object.assign(element.style, { left: `${frame.x - 6}px`, top: `${frame.y - 6}px`, width: `${frame.width + 12}px`, height: `${frame.height + 12}px` });
  globalThis.document.body.appendChild(element);
}

const removeSpots = () => globalThis.document.querySelectorAll('.clips-spot').forEach((element) => element.remove());

/** The part of the screen that scrolls, measured and put at its top; returns how far it can go. */
function prepareScroller() {
  const doc = globalThis.document;
  const candidates = [doc.scrollingElement, ...Array.from(doc.querySelectorAll('main, [data-screen-id], .workspace-main, .page-content'))].filter((element) => element !== null);
  const scroller = candidates.reduce((best, element) => (element.scrollHeight - element.clientHeight > best.scrollHeight - best.clientHeight ? element : best), candidates[0]);
  globalThis.__clipsScroller = scroller;
  scroller.scrollTop = 0;
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

const scrollTo = (top) => {
  globalThis.__clipsScroller.scrollTop = top;
};

export class Ui {
  /** `page` is a Playwright Page (or anything with the same methods: the tests pass a fake), `baseUrl` the address of the web app. */
  constructor(page, { baseUrl = '', slowMo = 1, persona } = {}) {
    this.page = page;
    this.baseUrl = baseUrl;
    this.slowMo = slowMo;
    this.persona = persona;
  }

  /** The locator a parsed target (scene.mjs parseTarget) names; the first match when there are several. */
  locate(target) {
    const { page } = this;
    switch (target.kind) {
      case 'role':
        return (target.name === undefined ? page.getByRole(target.role) : page.getByRole(target.role, { name: target.name })).first();
      case 'label':
        return page.getByLabel(target.value).first();
      case 'text':
        return page.getByText(target.value).first();
      case 'testid':
        return page.getByTestId(target.value).first();
      case 'placeholder':
        return page.getByPlaceholder(target.value).first();
      default:
        return page.locator(target.value).first();
    }
  }

  wait(ms) {
    return this.page.waitForTimeout(scaleMs(ms, this.slowMo));
  }

  /** Opens a path of the web app as the persona of the scene and waits until the screen has drawn and nothing on it is loading. */
  async goto(path, persona = this.persona) {
    await this.page.goto(`${this.baseUrl}${withPersona(path, persona)}`);
    await this.page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]', { timeout: 30_000 });
    await this.page.waitForFunction(() => globalThis.document.querySelector('[aria-busy="true"]') === null, undefined, { timeout: 15_000 }).catch(() => undefined);
    await this.wait(700);
  }

  /** Goes to another screen of the application without loading it again (the router listens to the history), and waits until that screen has drawn. */
  async within(path, screenId) {
    await this.page.evaluate((target) => {
      globalThis.history.pushState({}, '', target);
      globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'));
    }, path);
    await this.page.waitForFunction((id) => globalThis.document.querySelector('[data-screen-id]')?.getAttribute('data-screen-id') === id, screenId, { timeout: 30_000 });
    await this.page.waitForFunction(() => globalThis.document.querySelector('[aria-busy="true"]') === null, undefined, { timeout: 15_000 }).catch(() => undefined);
    await this.wait(700);
  }

  async point(locator) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (box === null) throw new Error('the target has no box to point at');
    await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: Math.round(22 * this.slowMo) });
  }

  async click(locator, { pause = 350 } = {}) {
    await this.point(locator);
    await this.wait(pause);
    await locator.click();
  }

  async hover(locator) {
    await this.point(locator);
    await this.wait(600);
  }

  async type(locator, text) {
    await this.click(locator, { pause: 200 });
    await locator.pressSequentially(text, { delay: scaleMs(70, this.slowMo) });
  }

  async press(key) {
    await this.page.keyboard.press(key);
    await this.wait(300);
  }

  async select(locator, option) {
    await this.point(locator);
    await this.wait(300);
    await locator.selectOption(option);
  }

  /** Draws a frame around a part of the screen for as long as `during` takes. */
  async spot(locator, during) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (box === null) throw new Error('the target has no box to frame');
    await this.page.evaluate(addSpot, box);
    try {
      return await during();
    } finally {
      await this.page.evaluate(removeSpots);
    }
  }

  /** Scrolls the part of the screen that scrolls, slowly from its top to its end over `ms`, so that the viewer sees all of it while the voice speaks. */
  async scrollThrough(ms) {
    const total = scaleMs(ms, this.slowMo);
    const steps = Math.max(1, Math.floor(total / 250));
    const distance = await this.page.evaluate(prepareScroller);
    if (distance < 40) {
      await this.page.waitForTimeout(total);
      return;
    }
    for (let index = 1; index <= steps; index += 1) {
      await this.page.evaluate(scrollTo, Math.round((distance * index) / steps));
      await this.page.waitForTimeout(250);
    }
  }

  /** Waits until the target is visible (a step that must not go on before the screen has what it talks about). */
  async expectVisible(locator, timeoutMs = 20_000) {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  }
}

/** Does one parsed action (scene.mjs parseAction) with `ui`. */
export async function runAction(ui, action) {
  switch (action.do) {
    case 'goto':
      return ui.goto(action.path, action.persona);
    case 'click':
      return ui.click(ui.locate(action.target), action.pause === undefined ? undefined : { pause: action.pause });
    case 'hover':
      return ui.hover(ui.locate(action.target));
    case 'type':
      return ui.type(ui.locate(action.target), action.text);
    case 'press':
      return ui.press(action.key);
    case 'select':
      return ui.select(ui.locate(action.target), action.option);
    case 'scroll':
      return ui.scrollThrough(action.ms);
    case 'spot':
      return ui.spot(ui.locate(action.target), () => ui.wait(action.ms));
    case 'expect':
      return ui.expectVisible(ui.locate(action.target), action.timeoutMs);
    case 'wait':
      return ui.wait(action.ms);
    default:
      throw new Error(`unknown action ${action.do}`);
  }
}
