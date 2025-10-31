# 🥜 Nutshell

> **Hands-free browsing powered by head tracking and AI**

Nutshell makes the web accessible to everyone by combining computer vision-based head tracking with Chrome's Built-In AI to enable completely hands-free browsing and instant link summaries.

![Nutshell Banner](./screenshot.png)

## 🎥 Demo Video

> **[📹 Watch the demo video here](#)** *(Coming soon!)*

See Nutshell in action - browse Wikipedia entirely hands-free and get AI-powered summaries with just a head movement!

---

## 🌟 The Problem

For millions of people with mobility impairments, repetitive strain injuries, or temporary disabilities, using a traditional mouse and keyboard can be painful, difficult, or impossible. Existing assistive technologies often require expensive hardware, complex setup, or compromise on user experience.

At the same time, the web is full of links—but clicking them means committing to a full page load just to see if the content is relevant. This creates friction for everyone, but especially for users who rely on alternative input methods where every interaction has a higher cost.

---

## 💡 The Solution

**Nutshell** solves both problems with two powerful features:

### 1. 🎯 Head Tracking (Hands-Free Cursor Control)
Using your computer's webcam and facial recognition AI, Nutshell translates your head movements into precise cursor control:
- **Look left/right** → cursor moves horizontally
- **Tilt up/down** → cursor moves vertically
- **Dwell on a link** → automatically activates it (no clicking needed!)

No special hardware required—just your built-in webcam.

### 2. 🤖 AI-Powered Link Summaries
Nutshell uses **Chrome's Built-In AI** to instantly summarize any link you hover over:
- Extracts the article content automatically
- Generates a concise summary in seconds using on-device AI
- Shows summaries in an elegant tooltip or side panel
- Works completely offline (no data sent to external servers!)

**The result?** Browse the web entirely hands-free while getting instant previews of every link—all without leaving your current page.

---

## 🏆 Chrome Built-In AI Challenge

Nutshell is built for the [Chrome Built-In AI Challenge](https://developer.chrome.com/docs/ai/built-in) and leverages Chrome's latest on-device AI capabilities:

### ✅ **Summarization API**
- Generates high-quality, concise summaries of web content
- Runs entirely on-device using **Gemini Nano**
- Configurable summary types (key-points, tl;dr, teaser, headline)
- No network latency, no privacy concerns

### ✅ **Prompt API** (Optional)
- Allows users to customize their own summarization prompts
- Full control over summary style and length
- Powered by the same local Gemini Nano model

**Why this matters:** By using Chrome's Built-In AI, Nutshell delivers instant, privacy-respecting summaries without requiring external API keys, internet connectivity, or sending your data to third-party servers.

---

## ✨ Key Features

- **🎯 Head Tracking**: Control your cursor entirely with head movements—no hands required
- **📷 Webcam-Based**: Works with any standard webcam, no special hardware needed
- **🎚️ Calibration System**: Personalized 6-point calibration adapts to your range of motion
- **⏱️ Configurable Dwell Time**: Adjust how long to "hover" before activating (300-1200ms)
- **🤖 On-Device AI**: Summaries generated locally using Chrome's Gemini Nano model
- **🎨 Dual Display Modes**: Show summaries in tooltips, side panel, or both
- **⌨️ Keyboard Shortcuts**: Quick access to calibration, camera preview, and debug tools
- **🔒 Privacy-First**: All processing happens locally—no data leaves your device
- **🎨 Beautiful UI**: Clean, accessible interface with the adorable Nutshell mascot

---

## 🚀 Installation

### Prerequisites
- **Chrome Browser**: Version 127+ with Built-In AI enabled
- **Webcam**: Any standard webcam (built-in or external)
- **Enable Chrome AI**: Follow [these instructions](https://developer.chrome.com/docs/ai/built-in) to enable Chrome's experimental AI features

### Steps

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/nutshell-extension.git
   cd nutshell-extension
   ```

2. **Load the extension**
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" (top right)
   - Click "Load unpacked"
   - Select the `hover-preview-extension` folder

3. **Download AI Model** (First time only)
   - Click the Nutshell icon in your toolbar
   - If using Prompt API, you'll be prompted to download the Gemini Nano model (~2GB, one-time)
   - The Summarization API model downloads automatically when first used

4. **Grant Camera Permission**
   - When you enable head tracking, Chrome will request camera access
   - Click "Allow" to enable hands-free cursor control

---

## 🎮 How to Use

### Getting Started

1. **Open the Side Panel**
   - Click the Nutshell icon in your Chrome toolbar
   - The side panel will open with all controls

2. **Enable Head Tracking**
   - Toggle "Enable Head Tracking" in the side panel
   - Grant camera permission when prompted

3. **Calibrate Your Head Position**
   - Click "Calibrate Head Position" (or press `Alt+H`)
   - Follow the 6-point calibration instructions
   - Look at each circle and hold for a moment
   - Click "Done" when complete

4. **Start Browsing!**
   - Navigate to any webpage (Wikipedia works great!)
   - Move your head to control the cursor
   - Dwell on a link for 600ms (adjustable) to preview it
   - An AI summary appears instantly in a tooltip
   - Dwell on the summary's close button to dismiss it

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+H` | Calibrate head tracking |
| `Alt+P` | Toggle pointer visibility |
| `Alt+V` | Toggle camera preview |
| `Shift+H` | Toggle debug HUD |

### Tips for Best Results

- **Good Lighting**: Ensure your face is well-lit for better tracking accuracy
- **Steady Position**: Keep your torso relatively stable; move your head, not your whole body
- **Recalibrate**: If tracking feels off, just recalibrate—it takes 10 seconds!
- **Adjust Dwell Time**: If you're accidentally clicking links, increase the dwell time slider
- **Test on Wikipedia**: Wikipedia's dense inline links are perfect for testing

---

## 🛠️ Tech Stack

### Head Tracking
- **[Human.js](https://github.com/vladmandic/human)**: MediaPipe-based face detection and pose estimation
- **WebGL**: GPU-accelerated real-time processing
- **One-Euro Filter**: Advanced smoothing for jitter-free cursor movement

### AI Summarization
- **Chrome Summarization API**: Built-in, on-device AI using Gemini Nano
- **Chrome Prompt API**: Custom prompts for personalized summaries
- **Readability.js**: Content extraction from web pages

### Browser Integration
- **Chrome Extension Manifest V3**: Modern extension architecture
- **Side Panel API**: Dedicated UI for controls and summaries
- **Content Scripts**: Page interaction and tooltip rendering

---

## 🎯 How It Works

### Head Tracking Pipeline

1. **Face Detection**: Human.js detects 468 facial landmarks in real-time
2. **Pose Estimation**: Calculates head rotation (yaw/pitch) from facial mesh
3. **Coordinate Mapping**: Converts rotation angles to screen coordinates
4. **Smoothing**: One-Euro filter removes jitter while preserving responsiveness
5. **Cursor Control**: Dispatches mouse events to the active element
6. **Dwell Detection**: Tracks hover time and triggers actions at threshold

### AI Summary Pipeline

1. **Link Hover**: User dwells on a link for configured duration
2. **Content Fetch**: Background script fetches the target page
3. **Content Extraction**: Readability.js extracts clean article text
4. **AI Processing**: Chrome's Summarization API generates concise summary
5. **Display**: Summary appears in tooltip/panel with markdown formatting

---

## 🎨 Customization

### Display Settings
- **Location**: Choose tooltip-only, side panel-only, or both
- **API Choice**: Use Summarization API or write custom prompts
- **Custom Prompts**: "Summarize in 3 bullet points," "Explain like I'm 5," etc.

### Head Tracking Settings
- **Dwell Time**: 300ms (fast) to 1200ms (deliberate)
- **Pointer Visibility**: Toggle the visual cursor indicator
- **Camera Preview**: See what the tracking system sees
- **Debug HUD**: View FPS, confidence scores, and tracking status

---

## 🌍 Use Cases

### Accessibility
- Users with **mobility impairments** (paralysis, arthritis, etc.)
- **Repetitive strain injury (RSI)** prevention and management
- **Temporary disabilities** (broken arm, surgery recovery)
- Alternative input method for **motor control challenges**

### Productivity
- Hands-free research while taking notes or eating
- Quick link previews without page navigation
- Multitasking with second screen setups
- Reducing context-switching friction

### Research & Learning
- Rapid information gathering on Wikipedia
- Academic paper browsing with quick summaries
- News aggregation with preview-before-commit
- Learning new topics with guided exploration

---

## 🙏 Acknowledgments

Built with amazing open-source tools:
- **[Human.js](https://github.com/vladmandic/human)** by Vladimir Mandic - Face tracking library
- **[Readability.js](https://github.com/mozilla/readability)** by Mozilla - Content extraction
- **Chrome Built-In AI** by Google - On-device AI models
- **Nutshell mascot** - Designed with love 🥜

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details

---

## 🤝 Contributing

This project was built for the Chrome Built-In AI Challenge. Contributions, issues, and feature requests are welcome!

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📬 Contact

**Your Name** - [@yourtwitter](https://twitter.com/yourtwitter)

Project Link: [https://github.com/yourusername/nutshell-extension](https://github.com/yourusername/nutshell-extension)

---

<div align="center">

**Made with ❤️ for accessibility and powered by Chrome's Built-In AI**

🥜 *In a nutshell: Browse hands-free, understand faster.*

</div>
