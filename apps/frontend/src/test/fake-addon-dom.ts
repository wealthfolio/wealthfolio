class FakeClassList {
  private classes = new Set<string>();

  add(...classNames: string[]) {
    for (const className of classNames) {
      this.classes.add(className);
    }
  }

  remove(...classNames: string[]) {
    for (const className of classNames) {
      this.classes.delete(className);
    }
  }

  contains(className: string) {
    return this.classes.has(className);
  }

  setFromString(value: string) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }

  toString() {
    return Array.from(this.classes).join(" ");
  }
}

class FakeStyle {
  backgroundColor = "";
  color = "";
  colorScheme = "";
  fontFamily = "";
  private properties = new Map<string, string>();

  get length() {
    return this.propertyNames.length;
  }

  item(index: number) {
    return this.propertyNames[index] ?? "";
  }

  setProperty(propertyName: string, value: string) {
    this.properties.set(propertyName, value);
  }

  getPropertyValue(propertyName: string) {
    return this.properties.get(propertyName) ?? "";
  }

  removeProperty(propertyName: string) {
    this.properties.delete(propertyName);
  }

  private get propertyNames() {
    return Array.from(this.properties.keys());
  }
}

class FakeElement {
  readonly classList = new FakeClassList();
  style = new FakeStyle();
  textContent = "";
  private attributes = new Map<string, string>();
  private parent?: FakeHead;

  get className() {
    return this.classList.toString();
  }

  set className(value: string) {
    this.classList.setFromString(value);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    if (name === "style") {
      this.style = new FakeStyle();
      return;
    }
    this.attributes.delete(name);
  }

  attachTo(parent: FakeHead) {
    this.parent = parent;
  }

  remove() {
    this.parent?.removeChild(this);
  }
}

class FakeHead {
  private children: FakeElement[] = [];

  appendChild(element: FakeElement) {
    element.attachTo(this);
    this.children.push(element);
  }

  removeChild(element: FakeElement) {
    this.children = this.children.filter((child) => child !== element);
  }

  querySelectorAll(_selector: string) {
    return this.children.filter((element) => element.getAttribute("data-wealthfolio-addon-style"));
  }
}

class FakeDocument {
  readonly documentElement = new FakeElement();
  readonly body = new FakeElement();
  readonly head = new FakeHead();

  createElement(_tagName: string) {
    return new FakeElement();
  }
}

export function installFakeAddonDom() {
  const document = new FakeDocument();

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: document,
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: (element: FakeElement) => element.style,
  });

  return document;
}
