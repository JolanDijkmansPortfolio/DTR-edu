console.log("DTR-edu Game loaded");

const modelURL = "./model/model.json";
const metadataURL = "./model/metadata.json";

// Game state
let model;
let video;
let canvas;
let ctx;
let isRunning = false;
let videoTrack;
let currentDifficulty = null;
let score = 0;
let streak = 0;

// Tool detection state
const TOOLS = ["1-2", "7-8", "9-10", "11-12", "13-14", "17-18"];
let currentTool = null;
let correctAnswer = null;
let detectionBuffer = [];
const BUFFER_SIZE = 10; // 1.5 seconds of stable detection (150ms * 10)
const CONFIDENCE_THRESHOLD = 0.70;
let awaitingAnswer = false;

// Difficulty settings
const DIFFICULTY_SETTINGS = {
    easy: { options: 2 },
    medium: { options: 4 },
    hard: { options: 6 },
    expert: { options: 6 }
};

// Simple beep function (no audio files needed)
function playCorrectSound() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.frequency.value = 800;
        oscillator.type = 'sine';
        
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
        
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.2);
    } catch (e) {
        console.log("Audio not available");
    }
}

function playWrongSound() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.frequency.value = 200;
        oscillator.type = 'sawtooth';
        
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
        
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.3);
    } catch (e) {
        console.log("Audio not available");
    }
}

// Show status message
function showStatus(message, isError = false) {
    const statusEl = document.getElementById("statusMessage");
    if (statusEl) {
        statusEl.innerText = message;
        statusEl.style.color = isError ? "#b00020" : "#333";
    }
    console.log(message);
}

// Load model
async function loadModel() {
    console.log("Loading model...");
    
    if (typeof tmImage === 'undefined') {
        throw new Error("Teachable Machine library not loaded");
    }
    
    showStatus("Loading AI model...");
    
    try {
        model = await tmImage.load(modelURL, metadataURL);
        console.log("Model loaded:", model.getClassLabels().join(", "));
        showStatus("Model ready!");
        return true;
    } catch (err) {
        console.error("Model error:", err);
        showStatus("Failed to load model: " + err.message, true);
        throw err;
    }
}

// Start camera
async function startCamera() {
    console.log("Starting camera...");
    video = document.getElementById("video");
    canvas = document.getElementById("canvas");
    ctx = canvas.getContext("2d");

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 224 },
                height: { ideal: 224 }
            },
            audio: false
        });
        
        video.srcObject = stream;
        videoTrack = stream.getVideoTracks()[0];

        // Try torch
        try {
            const capabilities = videoTrack.getCapabilities();
            if (capabilities.torch) {
                await videoTrack.applyConstraints({ advanced: [{ torch: true }] });
                console.log("Torch enabled");
            }
        } catch (e) {
            console.log("Torch not available");
        }

        return new Promise((resolve) => {
            video.onloadedmetadata = () => {
                video.play().then(() => {
                    console.log("Camera started successfully");
                    resolve();
                });
            };
        });

    } catch (err) {
        console.error("Camera error:", err);
        showStatus("Camera error: " + err.message, true);
        throw err;
    }
}

// Update stability bar
function updateStabilityBar(progress) {
    const bar = document.getElementById("stabilityProgress");
    if (bar) {
        bar.style.width = (progress * 100) + "%";
    }
}

// Prediction loop with buffering
async function predictLoop() {
    if (!isRunning) return;

    try {
        ctx.drawImage(video, 0, 0, 224, 224);
        const prediction = await model.predict(canvas);

        let best = prediction[0];
        for (let p of prediction) {
            if (p.probability > best.probability) {
                best = p;
            }
        }

        const detectedClass = best.className;
        const confidence = best.probability;

        // Update detection display
        const detectedToolEl = document.getElementById("detectedTool");
        if (detectedToolEl) {
            detectedToolEl.innerText = 
                TOOLS.includes(detectedClass) ? `Tool ${detectedClass}` : "Show a tool...";
        }

        // Only process tool detections when waiting for answer
        if (awaitingAnswer) {
            if (detectedToolEl) {
                detectedToolEl.innerText = "Select an answer below";
            }
            updateStabilityBar(0);
        } else if (TOOLS.includes(detectedClass) && confidence >= CONFIDENCE_THRESHOLD) {
            // Add to buffer
            detectionBuffer.push(detectedClass);
            if (detectionBuffer.length > BUFFER_SIZE) {
                detectionBuffer.shift();
            }

            // Check if buffer is stable
            const mostCommon = detectionBuffer.reduce((acc, val) => {
                acc[val] = (acc[val] || 0) + 1;
                return acc;
            }, {});

            const stableDetection = Object.keys(mostCommon).find(
                tool => mostCommon[tool] >= BUFFER_SIZE * 0.8
            );

            if (stableDetection) {
                updateStabilityBar(1);
                // Stable detection achieved!
                currentTool = stableDetection;
                showDiagramOptions(stableDetection);
            } else {
                updateStabilityBar(detectionBuffer.length / BUFFER_SIZE);
            }
        } else {
            // Reset buffer if detection lost
            detectionBuffer = [];
            updateStabilityBar(0);
        }

    } catch (err) {
        console.error("Prediction error:", err);
    }

    setTimeout(() => requestAnimationFrame(predictLoop), 150);
}

// Show diagram options for selection
function showDiagramOptions(tool) {
    awaitingAnswer = true;
    correctAnswer = tool;
    detectionBuffer = [];

    const optionsContainer = document.getElementById("diagramOptions");
    optionsContainer.innerHTML = "";

    const numOptions = DIFFICULTY_SETTINGS[currentDifficulty].options;
    
    // Get wrong options
    let options = [tool];
    const otherTools = TOOLS.filter(t => t !== tool);
    
    while (options.length < numOptions) {
        const randomTool = otherTools[Math.floor(Math.random() * otherTools.length)];
        if (!options.includes(randomTool)) {
            options.push(randomTool);
        }
    }

    // Shuffle options
    options.sort(() => Math.random() - 0.5);

    // Create diagram buttons
    options.forEach(optionTool => {
        const btn = document.createElement("div");
        btn.className = "diagramOption";
        
        const img = document.createElement("img");
        img.src = `./mouth-diagrams/${optionTool}.png`;
        img.alt = `Tool ${optionTool}`;
        
        btn.appendChild(img);
        btn.onclick = () => checkAnswer(optionTool);
        
        optionsContainer.appendChild(btn);
    });

    const instructionEl = document.getElementById("instruction");
    if (instructionEl) {
        instructionEl.innerText = `Tool ${tool} detected! Select the correct usage diagram:`;
    }
}

// Check answer
function checkAnswer(selectedTool) {
    if (!awaitingAnswer) return;

    const feedback = document.getElementById("feedback");
    const isCorrect = selectedTool === correctAnswer;

    if (isCorrect) {
        // Correct answer
        score += 10;
        streak++;
        
        feedback.innerHTML = `
            <div class="feedbackCorrect">
                ✓ Correct! +10 points
            </div>
        `;
        
        playCorrectSound();

        // Highlight correct answer
        document.querySelectorAll(".diagramOption").forEach(opt => {
            const img = opt.querySelector("img");
            if (img.src.includes(correctAnswer)) {
                opt.classList.add("correct");
            }
        });

    } else {
        // Wrong answer
        score = Math.max(0, score - 5);
        streak = 0;
        
        feedback.innerHTML = `
            <div class="feedbackWrong">
                ✗ Wrong! -5 points<br>
                Correct answer: Tool ${correctAnswer}
            </div>
        `;
        
        playWrongSound();

        // Highlight correct and wrong answers
        document.querySelectorAll(".diagramOption").forEach(opt => {
            const img = opt.querySelector("img");
            if (img.src.includes(correctAnswer)) {
                opt.classList.add("correct");
            } else if (img.src.includes(selectedTool)) {
                opt.classList.add("wrong");
            }
        });
    }

    // Update score display
    document.getElementById("score").innerText = score;
    document.getElementById("streak").innerText = streak;

    // Reset after 2 seconds
    setTimeout(resetRound, 2000);
}

// Reset for next round
function resetRound() {
    awaitingAnswer = false;
    currentTool = null;
    correctAnswer = null;
    
    document.getElementById("diagramOptions").innerHTML = "";
    document.getElementById("feedback").innerHTML = "";
    
    const instructionEl = document.getElementById("instruction");
    if (instructionEl) {
        instructionEl.innerText = "Present a dental tool to the camera";
    }
    updateStabilityBar(0);
}

// Start game with selected difficulty
async function startGame(difficulty) {
    console.log("Starting game with difficulty:", difficulty);
    currentDifficulty = difficulty;
    
    document.getElementById("difficultyScreen").style.display = "none";
    document.getElementById("gameScreen").style.display = "block";
    
    showStatus("Starting game...");
    
    try {
        await loadModel();
        await startCamera();
        
        isRunning = true;
        showStatus("Game started! Show a tool to the camera");
        predictLoop();
        
    } catch (err) {
        console.error("Game start error:", err);
        showStatus("Error: " + err.message, true);
        alert("Failed to start: " + err.message);
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    console.log("DOM ready - DTR-edu");
    
    // Difficulty button handlers
    const buttons = document.querySelectorAll(".difficultyBtn");
    console.log("Found", buttons.length, "difficulty buttons");
    
    buttons.forEach(btn => {
        btn.addEventListener("click", function() {
            const level = this.getAttribute("data-level");
            console.log("Button clicked, level:", level);
            startGame(level);
        });
    });
});
