/**
 * 输入事件处理器
 * 将客户端的鼠标、键盘事件转发到 Puppeteer 页面
 */

class InputHandler {
  constructor(page) {
    this.page = page;
    this.lastMouseX = 0;
    this.lastMouseY = 0;
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

    // 处理修饰键组合
    if (modifiers.ctrl) await this.page.keyboard.down('Control');
    if (modifiers.alt) await this.page.keyboard.down('Alt');
    if (modifiers.shift) await this.page.keyboard.down('Shift');
    if (modifiers.meta) await this.page.keyboard.down('Meta');

    await this.page.keyboard.down(key);
  }

  // 键盘释放
  async handleKeyUp(event) {
    const { key, code, modifiers = {} } = event;

    try { await this.page.keyboard.up(key); } catch (e) {
      if (!e.message.includes('not pressed')) throw e;
    }

    // 释放修饰键（忽略未按下的情况）
    if (modifiers.meta) try { await this.page.keyboard.up('Meta'); } catch (e) {}
    if (modifiers.shift) try { await this.page.keyboard.up('Shift'); } catch (e) {}
    if (modifiers.alt) try { await this.page.keyboard.up('Alt'); } catch (e) {}
    if (modifiers.ctrl) try { await this.page.keyboard.up('Control'); } catch (e) {}
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
