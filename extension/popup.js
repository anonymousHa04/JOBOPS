document.addEventListener('DOMContentLoaded', async () => {
    const jobSelect = document.getElementById('jobSelect');
    const getReportButton = document.getElementById('getReport');
    const saveSelectionButton = document.getElementById('saveSelection');
    const statusDiv = document.getElementById('status');

    // Fetch jobs and populate the select element
    try {
        const response = await fetch('http://127.0.0.1:3000/x/jobs');
        if (!response.ok) {
            throw new Error('Failed to fetch jobs');
        }
        const data = await response.json();
        data.jobs.forEach(job => {
            const option = document.createElement('option');
            option.value = job.job_id;
            // Jobs never tailored have no score or decision.
            const score = job.score != null ? `${job.score} ` : '';
            const decision = job.decision ? ` (${job.decision})` : '';
            option.textContent = `${score}${job.company} - ${job.title}${decision}${job.reports.length > 0 ? ' [report]' : ''}`;
            jobSelect.appendChild(option);
        });
    } catch (error) {
        statusDiv.textContent = 'Start JobOps first: npm start (in the project folder)';
    }

    // Load last selected job and target from storage
    chrome.storage.local.get(['lastJobId', 'lastTarget', 'status'], (result) => {
        if (result.lastJobId) {
            jobSelect.value = result.lastJobId;
        }
        if (result.lastTarget) {
            document.querySelector(`input[name="target"][value="${result.lastTarget}"]`).checked = true;
        }
        if (result.status) {
            showStatus(result.status);
        }
    });

    // Save selected job and target to storage
    jobSelect.addEventListener('change', () => {
        chrome.storage.local.set({ lastJobId: jobSelect.value });
    });
    document.querySelectorAll('input[name="target"]').forEach(input => {
        input.addEventListener('change', () => {
            chrome.storage.local.set({ lastTarget: input.value });
        });
    });

    // Handle "Get report" button click
    getReportButton.addEventListener('click', () => {
        const jobId = jobSelect.value;
        const target = document.querySelector('input[name="target"]:checked').value;
        chrome.runtime.sendMessage({ type: "run", jobId, target }, (response) => {
            if (chrome.runtime.lastError || !response) {
                document.getElementById('status').innerText = 'The extension background did not answer; reload the extension';
                return;
            }
            showStatus(response.status);
        });
    });

    // Handle "Save selected text" button click
    saveSelectionButton.addEventListener('click', () => {
        const jobId = jobSelect.value;
        const target = document.querySelector('input[name="target"]:checked').value;
        chrome.runtime.sendMessage({ type: "saveSelection", jobId, target }, (response) => {
            if (chrome.runtime.lastError || !response) {
                document.getElementById('status').innerText = 'The extension background did not answer; reload the extension';
                return;
            }
            showStatus(response.status);
        });
    });

    // Update status line on storage change
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes.status) {
            const status = changes.status.newValue;
            showStatus(status);
        }
    });
});

function showStatus(status) {
    if (!status) {
        document.getElementById('status').innerText = '';
        return;
    }
    let statusText = `Status: ${status.step}`;
    if (status.error) {
        statusText += ` - Error: ${status.error}`;
    } else if (status.path) {
        statusText += ` - Saved: ${status.path}`;
    }
    document.getElementById('status').innerText = statusText;
}
