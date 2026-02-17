/**
 * 输入事件处理器
 * 将客户端的鼠标、键盘事件转发到 Puppeteer 页面
 */

class InputHandler {
  constructor(page) {
    this.page = page;
    this.lastMouseX = 0;
    this.lastMouseY = 0;
    this.syntheticTypedKeys = new Set();
  }

  // 动态切换目标页面（Tab 切换时调用）
  setPage(page) {
    this.page = page;
  }

  // 处理输入事件
  async handleEvent(event) {
    if (!this.page) return;
    try {
      switch (event.type) {
        case 'mousemove':
          await this.handleMouseMove(event);
          break;
        case 'mousedown':
          await this.handleMouseDown(event);
          break;
        case 'mouseup':
          await this.handleMouseUp(event);
          break;
        case 'click':
          await this.handleClick(event);
          break;
        case 'dblclick':
          await this.handleDoubleClick(event);
          break;
        case 'wheel':
        case 'scroll':
          await this.handleScroll(event);
          break;
        case 'keydown':
          await this.handleKeyDown(event);
          break;
        case 'keyup':
          await this.handleKeyUp(event);
          break;
        case 'keypress':
          await this.handleKeyPress(event);
          break;
        case 'contextmenu':
          await this.handleContextMenu(event);
          break;
        default:
          // 忽略未知事件
          break;
      }
    } catch (e) {
      // 忽略 Target closed 等瞬态错误
      if (!e.message.includes('Target closed') && !e.message.includes('Session closed')) {
        console.error(`[InputHandler] Event handling error:`, e.message);
      }
    }
  }

  // 鼠标移动
  async handleMouseMove(event) {
    const { x, y } = event;
    this.lastMouseX = x;
    this.lastMouseY = y;
    await this.page.mouse.move(x, y);
  }

  // 鼠标按下
  async handleMouseDown(event) {
    const { x, y, button = 'left' } = event;
    if (x !== undefined && y !== undefined) {
      await this.page.mouse.move(x, y);
    }
    await this.page.mouse.down({ button: this.mapButton(button) });
  }

  // 鼠标释放
  async handleMouseUp(event) {
    const { x, y, button = 'left' } = event;
    if (x !== undefined && y !== undefined) {
      await this.page.mouse.move(x, y);
    }
    // Chromium 自动化下 middle click 对链接不稳定，优先尝试 window.open。
    // 若被站点策略/弹窗拦截，则回退到原生 middle mouseup。
    if (this.mapButton(button) === 'middle' && x !== undefined && y !== undefined) {
      const href = await this.page.evaluate(({ px, py }) => {
        const el = document.elementFromPoint(px, py);
        const link = el && el.closest ? el.closest('a[href]') : null;
        return link ? link.href : '';
      }, { px: x, py: y }).catch(() => '');

      if (href) {
        const opened = await this.page.evaluate((url) => {
          try {
            const w = window.open(url, '_blank');
            return !!w;
          } catch (_) {
            return false;
          }
        }, href).catch(() => false);

        if (opened) {
          // programmatic open 成功时，抑制原生 auxclick，避免 mouseup 再开一个 tab
          // 注意：若 open 失败，不能抑制原生 middle-up，否则会出现“偶发开不出 tab”。
          try {
            await this.page.evaluate(() => {
              document.addEventListener('auxclick', function _suppress(e) {
                e.preventDefault();
                e.stopImmediatePropagation();
                document.removeEventListener('auxclick', _suppress, true);
              }, { capture: true });
            });
          } catch (_) {}
          try {
            await this.page.mouse.up({ button: 'middle' });
          } catch (e) {
            if (!e.message.includes('not pressed')) throw e;
          }
          return;
        }

        // window.open 被拦截时，回退到原生 middle-up。
        try {
          await this.page.mouse.up({ button: 'middle' });
        } catch (e) {
          if (!e.message.includes('not pressed')) throw e;
        }
        return;
      }
    }
    try {
      await this.page.mouse.up({ button: this.mapButton(button) });
    } catch (e) {
      // 忽略 "button is not pressed" 错误（mouseup 没有对应 mousedown 时）
      if (!e.message.includes('not pressed')) throw e;
    }
  }

  // 单击
  async handleClick(event) {
    const { x, y, button = 'left' } = event;
    await this.page.mouse.click(x, y, { button: this.mapButton(button) });
  }

  // 双击
  async handleDoubleClick(event) {
    const { x, y } = event;
    await this.page.mouse.click(x, y, { clickCount: 2 });
  }

  // 滚轮/滚动
  async handleScroll(event) {
    const { deltaX = 0, deltaY = 0, x, y } = event;

    if (x !== undefined && y !== undefined) {
      await this.page.mouse.move(x, y);
    }

    await this.page.mouse.wheel({ deltaX, deltaY });
  }

  // 键盘按下
  async handleKeyDown(event) {
    const { key, code, modifiers = {} } = event;
    // For printable keys, typing is more reliable across layouts/IME than keydown/keyup.
    if (this.isPrintableKey(key) && !modifiers.ctrl && !modifiers.alt && !modifiers.meta) {
      await this.page.keyboard.type(key);
      this.syntheticTypedKeys.add(this.keyIdentity(key, code));
      return;
    }
    await this.page.keyboard.down(this.normalizeKey(key));
  }

  // 键盘释放
  async handleKeyUp(event) {
    const { key, code } = event;
    const id = this.keyIdentity(key, code);
    if (this.syntheticTypedKeys.has(id)) {
      this.syntheticTypedKeys.delete(id);
      return;
    }
    try { await this.page.keyboard.up(this.normalizeKey(key)); } catch (e) {
      if (!e.message.includes('not pressed')) throw e;
    }
  }

  // 键盘输入
  async handleKeyPress(event) {
    const { key, text } = event;

    if (text) {
      await this.page.keyboard.type(text);
    } else if (key) {
      await this.page.keyboard.press(key);
    }
  }

  // 右键菜单
  async handleContextMenu(event) {
    const { x, y } = event;
    await this.page.mouse.click(x, y, { button: 'right' });
  }

  keyIdentity(key, code) {
    return `${String(code || '')}|${String(key || '')}`;
  }

  isPrintableKey(key) {
    return typeof key === 'string' && key.length === 1;
  }

  normalizeKey(key) {
    const map = {
      ' ': 'Space',
      Esc: 'Escape',
      Del: 'Delete',
      Left: 'ArrowLeft',
      Right: 'ArrowRight',
      Up: 'ArrowUp',
      Down: 'ArrowDown'
    };
    return map[key] || key;
  }

  // 映射按钮名称
  mapButton(button) {
    const buttonMap = {
      0: 'left',
      1: 'middle',
      2: 'right',
      'left': 'left',
      'middle': 'middle',
      'right': 'right'
    };
    return buttonMap[button] || 'left';
  }
}

module.exports = InputHandler;
