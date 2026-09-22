# SmartWindowSize

**SmartWindowSize** is a browser extension that remembers the size of your browser window for different websites and automatically restores it when you return.

It is useful when you regularly use different websites that are more convenient at different window sizes.

For example, you may want:

* a web application to open in a large window,
* a documentation site in a medium-sized window,
* a narrow window for a chat or monitoring page,
* a specific page to always open at a particular size.

SmartWindowSize remembers these preferences and applies them automatically.

## How it works

SmartWindowSize remembers the **browser window size**, not the size of the web page itself.

When you open a website, the extension checks whether you have previously saved a preferred window size for that website. If you have, the browser window is resized accordingly.

The extension can remember settings at different levels:

* **Domain** — applies to the entire website.
* **Subdomain** — applies to a particular subdomain.
* **Path** — applies to a particular section of a website.
* **Page** — applies only to one specific page.

More specific settings take precedence over more general ones.

For example:

```text
example.com              → 1200 × 900
blog.example.com         → 1300 × 900
blog.example.com/news/   → 1400 × 1000
blog.example.com/news/1  → 800 × 700
```

In this example, the specific page gets `800 × 700`, while other pages in `/news/` use `1400 × 1000`.

The more general settings are not deleted when a more specific setting is created.

## Remembering a window size

Open a website and resize the browser window to the desired size.

You can then use the SmartWindowSize popup to choose where that size should be remembered:

* Remember for domain
* Remember for subdomain
* Remember for path
* Remember for page

The selected setting is saved for that scope.

If a setting for that scope already exists, it is updated rather than creating another one.

## Different sizes for different parts of a website

You can combine different levels of settings.

For example:

```text
example.com
    1200 × 900

blog.example.com
    1400 × 900

blog.example.com/articles/
    1200 × 1000

blog.example.com/articles/special
    900 × 800
```

This allows you to have a general window size while creating exceptions where necessary.

Removing an exception causes the browser to fall back to the next applicable setting.

## Multiple browser tabs

SmartWindowSize takes the **active tab** into account.

This means that different tabs in the same browser window can have different preferred window sizes.

For example:

```text
Tab A → 1200 × 900
Tab B → 1600 × 1000
```

When you switch between the tabs, SmartWindowSize can adjust the browser window to the size associated with the newly active tab.

## Default window size

SmartWindowSize has a global default window size.

The default is:

**1200 × 960 pixels**

You can change this in the configuration.

There is also an option to use the current browser window size as the new default.

The default is used when no more specific remembered setting exists.

## Automatically remembering new websites

You can choose whether SmartWindowSize should automatically remember the size of new websites.

### Remember by default

When enabled, visiting a new website can automatically create a setting using the default scope.

### Do not remember by default

When disabled, SmartWindowSize does not create a new setting automatically.

You can still explicitly choose **Remember for domain**, **Remember for subdomain**, **Remember for path**, or **Remember for page** whenever you want.

## Temporarily disabling a setting

You can disable SmartWindowSize for a particular scope.

This is a persistent setting: it remains disabled until you enable it again.

The toolbar icon shows the current state:

* **Colored icon** — SmartWindowSize is active.
* **Gray icon** — SmartWindowSize is disabled.

## Toolbar popup

Click the SmartWindowSize icon in the browser toolbar to open the popup.

The popup provides quick access to the settings relevant to the current page, including:

* Enable or disable the current setting
* Remember the window size for the domain
* Remember the window size for the subdomain
* Remember the window size for a path
* Remember the window size for the current page
* Save the current window size
* Use the current window size as the global default
* Reset or remove a saved setting
* Open the full configuration

Toggle options are shown with a checkmark when enabled.

## Right-click menu

The same quick actions are also available by right-clicking the SmartWindowSize icon in the browser toolbar.

This allows you to change the most common settings without opening the popup.

## Window position and monitors

In addition to the window size, SmartWindowSize can optionally remember the **position** of the browser window.

It can also optionally remember the monitor on which the window was located.

This is useful when working with multiple monitors.

If the previously used monitor is no longer available, SmartWindowSize uses an available monitor instead.

You can choose whether position and monitor information should be remembered.

## Screen size limitations

If a saved window size is larger than the available screen area, SmartWindowSize automatically adjusts the restored window so that it fits the available workspace.

You can still manually move or resize the browser window outside the visible screen area if you want to.

Such an off-screen state is not automatically saved as the remembered size or position.

## Managing all settings

The full configuration page allows you to see and manage all SmartWindowSize settings.

You can:

* change the default window size,
* change default remembering behavior,
* configure position and monitor remembering,
* view saved website settings,
* change individual settings,
* enable or disable settings,
* remove settings,
* and manage the complete configuration.

You do not have to visit a website in order to manage an existing setting.

## Import and export

SmartWindowSize can export its complete configuration to a JSON file.

This allows you to:

* make a backup,
* move your settings to another browser,
* move your settings to another computer,
* restore settings after reinstalling the extension.

An exported configuration can be imported again through the configuration page.

## Installation

SmartWindowSize is designed primarily for **Brave Browser** and other compatible Chromium-based browsers.

For development or manual installation:

1. Open the browser's extensions page.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the SmartWindowSize extension folder.
5. Pin SmartWindowSize to the browser toolbar if desired.

## Typical use

A simple workflow is:

1. Open the website.
2. Resize the browser window to the size you prefer.
3. Click the SmartWindowSize icon.
4. Choose the desired scope, such as **Remember for domain**.
5. Continue browsing normally.

The next time you open that website, SmartWindowSize will restore the saved window size automatically.

You can create more specific settings later whenever a particular page or section of the website needs a different window size.
