export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

export const toolDefinitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'snapshot',
      description:
        'Take a snapshot of the current page to see its accessibility tree with element refs. Call this after navigation or when you need to see the current page state.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click on an element identified by its ref from the snapshot.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from snapshot (e.g., "e5")' },
          doubleClick: { type: 'boolean', description: 'Double-click instead of single click' },
          button: {
            type: 'string',
            enum: ['left', 'right', 'middle'],
            description: 'Mouse button',
          },
          modifiers: {
            type: 'array',
            items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
          },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type',
      description: 'Type text into an input element identified by its ref.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from snapshot' },
          text: { type: 'string', description: 'Text to type' },
          submit: { type: 'boolean', description: 'Press Enter after typing' },
          slowly: {
            type: 'boolean',
            description: 'Type one character at a time (for sites that need key events)',
          },
        },
        required: ['ref', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate the current tab to a URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description:
        'Capture a screenshot of the current page. Returns base64-encoded PNG. Use when you need to visually inspect the page.',
      parameters: {
        type: 'object',
        properties: {
          fullPage: { type: 'boolean', description: 'Capture the full scrollable page' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'press',
      description: 'Press a keyboard key.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Key to press (e.g., "Enter", "Tab", "Escape", "ArrowDown")',
          },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Scroll an element into view.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref to scroll into view' },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hover',
      description: 'Hover over an element.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref to hover over' },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'drag',
      description: 'Drag from one element to another.',
      parameters: {
        type: 'object',
        properties: {
          startRef: { type: 'string', description: 'Ref of element to drag from' },
          endRef: { type: 'string', description: 'Ref of element to drag to' },
        },
        required: ['startRef', 'endRef'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select',
      description: 'Select option(s) in a dropdown/select element.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Ref of the select element' },
          values: {
            type: 'array',
            items: { type: 'string' },
            description: 'Option values to select',
          },
        },
        required: ['ref', 'values'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fill',
      description: 'Batch fill multiple form fields at once.',
      parameters: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'string' },
                type: { type: 'string', enum: ['text', 'checkbox', 'radio', 'select'] },
                value: { type: 'string' },
              },
              required: ['ref', 'type', 'value'],
            },
          },
        },
        required: ['fields'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: 'Wait for a condition before continuing.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Wait for this text to appear on the page' },
          textGone: { type: 'string', description: 'Wait for this text to disappear' },
          selector: { type: 'string', description: 'Wait for this CSS selector to exist' },
          url: {
            type: 'string',
            description: 'Wait for URL to match (supports glob patterns)',
          },
          fn: {
            type: 'string',
            description: 'Wait for this JS expression to return truthy',
          },
          timeoutMs: { type: 'number', description: 'Timeout in ms (default: 10000)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'evaluate',
      description: 'Execute JavaScript in the page context.',
      parameters: {
        type: 'object',
        properties: {
          fn: {
            type: 'string',
            description: 'JavaScript expression or function to evaluate',
          },
          ref: {
            type: 'string',
            description: 'Optional: element ref to pass as argument to the function',
          },
        },
        required: ['fn'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tab_list',
      description: 'List all open browser tabs.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tab_open',
      description: 'Open a new tab with the given URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tab_close',
      description: 'Close a tab by its ID.',
      parameters: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID from tab_list' },
        },
        required: ['tabId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tab_focus',
      description: 'Focus/switch to a tab by its ID.',
      parameters: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID from tab_list' },
        },
        required: ['tabId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cookies_get',
      description: 'Get cookies for the current page.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cookies_set',
      description: 'Set a cookie.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          value: { type: 'string' },
          domain: { type: 'string' },
          path: { type: 'string' },
          secure: { type: 'boolean' },
          httpOnly: { type: 'boolean' },
        },
        required: ['name', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cookies_clear',
      description: 'Clear cookies for the current page.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_viewport',
      description: 'Set the browser viewport size.',
      parameters: {
        type: 'object',
        properties: {
          width: { type: 'number' },
          height: { type: 'number' },
        },
        required: ['width', 'height'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pdf',
      description: 'Export the current page as a PDF.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];
