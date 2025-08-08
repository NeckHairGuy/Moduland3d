let THREE;
let ipcRenderer;

try {
  THREE = require('three');
  ipcRenderer = require('electron').ipcRenderer;
} catch (error) {
  console.error('Failed to load dependencies:', error);
}

let scene, camera, renderer, controls;
let raycaster, mouse;
let groundGrid = [];
let voxels = [];
let selectedVoxels = [];
let savedStructures = [];
let currentTool = 'select';
let gridSizeX = 20;
let gridSizeZ = 20;
let voxelSize = 1;
// Default isometric view angles (degrees)
const DEFAULT_ISO_ELEVATION_DEG = 35.264; // classic iso elevation ~arctan(sin(45))
const DEFAULT_ISO_AZIMUTH_DEG = 45;       // classic iso azimuth
let gizmoGroup;
let activeGizmo = null;
let isDraggingGizmo = false;
let currentZoom = 1;
let dragStartPos = null;
let previewGroup;
let dragAxis = null;
let dragDirection = 1;
let shiftPressed = false;
let heightLimit = 20;
let focusMode = false;
let focusedStructure = null;
let focusedStructureVoxels = new Set();
let buildingInstanceGroup = null;
let originalStructureSnapshot = null;
let renderBuildingEnabled = false;

function init() {
    if (!THREE) {
        console.error('THREE.js not loaded');
        return;
    }
    
    try {
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0xf0f0f0);
    
    const container = document.getElementById('scene-container');
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    const frustumSize = 30;
    const aspect = width / height;
    camera = new THREE.OrthographicCamera(
        frustumSize * aspect / -2,
        frustumSize * aspect / 2,
        frustumSize / 2,
        frustumSize / -2,
        0.1,
        1000
    );
    camera.position.set(20, 20, 20);
    camera.lookAt(0, 0, 0);
    
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(10, 20, 10);
    directionalLight.castShadow = true;
    directionalLight.shadow.camera.left = -20;
    directionalLight.shadow.camera.right = 20;
    directionalLight.shadow.camera.top = 20;
    directionalLight.shadow.camera.bottom = -20;
    scene.add(directionalLight);
    
    createGroundGrid();
    
    gizmoGroup = new THREE.Group();
    scene.add(gizmoGroup);
    
    previewGroup = new THREE.Group();
    scene.add(previewGroup);
    
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();
    
    setupControls();
    setupEventListeners();
    
    animate();
    } catch (error) {
        console.error('Error initializing scene:', error);
    }
}

function createGroundGrid() {
    // Clear existing grid
    clearGroundGrid();
    
    const maxGridSize = Math.max(gridSizeX, gridSizeZ);
    const gridHelper = new THREE.GridHelper(maxGridSize, maxGridSize, 0x888888, 0xcccccc);
    gridHelper.userData.isGridHelper = true;
    scene.add(gridHelper);
    
    const planeGeometry = new THREE.PlaneGeometry(maxGridSize, maxGridSize);
    const planeMaterial = new THREE.MeshBasicMaterial({ 
        color: 0xffffff, 
        opacity: 0.1, 
        transparent: true,
        side: THREE.DoubleSide
    });
    const plane = new THREE.Mesh(planeGeometry, planeMaterial);
    plane.rotation.x = -Math.PI / 2;
    plane.receiveShadow = true;
    plane.userData.isGridPlane = true;
    scene.add(plane);
    
    groundGrid = [];
    for (let x = 0; x < gridSizeX; x++) {
        groundGrid[x] = [];
        for (let z = 0; z < gridSizeZ; z++) {
            const geometry = new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize);
            const material = new THREE.MeshPhongMaterial({ 
                color: 0xe0e0e0,
                emissive: 0x000000,
                emissiveIntensity: 0
            });
            const cube = new THREE.Mesh(geometry, material);
            cube.position.set(
                Math.floor(x - gridSizeX / 2 + 0.5),
                0,
                Math.floor(z - gridSizeZ / 2 + 0.5)
            );
            cube.userData = { gridX: x, gridZ: z, type: 'ground', selected: false, baseColor: 0xe0e0e0 };
            cube.castShadow = true;
            cube.receiveShadow = true;
            
            // Add edge highlights
            const edges = new THREE.EdgesGeometry(geometry);
            const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 });
            const edgeLines = new THREE.LineSegments(edges, edgeMaterial);
            edgeLines.position.copy(cube.position);
            cube.userData.edges = edgeLines;
            scene.add(edgeLines);
            
            // Apply height-based coloring
            updateVoxelColor(cube);
            
            scene.add(cube);
            groundGrid[x][z] = cube;
        }
    }
}

function clearGroundGrid() {
    // Remove existing grid voxels
    if (groundGrid.length > 0) {
        groundGrid.flat().forEach(voxel => {
            if (voxel) {
                scene.remove(voxel);
                
                // Remove edges if they exist
                if (voxel.userData.edges) {
                    scene.remove(voxel.userData.edges);
                    if (voxel.userData.edges.geometry) voxel.userData.edges.geometry.dispose();
                    if (voxel.userData.edges.material) voxel.userData.edges.material.dispose();
                }
                
                voxel.geometry.dispose();
                voxel.material.dispose();
            }
        });
    }
    
    // Remove grid helper and plane
    scene.children.filter(child => 
        child.userData.isGridHelper || child.userData.isGridPlane
    ).forEach(child => {
        scene.remove(child);
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
    });
}

function setupControls() {
    renderer.domElement.addEventListener('wheel', (event) => {
        event.preventDefault();
        const zoomSpeed = 0.002;
        currentZoom *= 1 - (event.deltaY * zoomSpeed);
        currentZoom = Math.max(0.3, Math.min(4, currentZoom));
        
        const frustumSize = 30 / currentZoom;
        const aspect = camera.aspect || (camera.right - camera.left) / (camera.top - camera.bottom);
        
        camera.left = frustumSize * aspect / -2;
        camera.right = frustumSize * aspect / 2;
        camera.top = frustumSize / 2;
        camera.bottom = frustumSize / -2;
        camera.updateProjectionMatrix();
    });
    
    let isRotating = false;
    let isPanning = false;
    let previousMousePosition = { x: 0, y: 0 };
    let cameraTarget = new THREE.Vector3(0, 0, 0);
    
    renderer.domElement.addEventListener('mousedown', (event) => {
        if (event.button === 2) {
            if (shiftPressed) {
                isPanning = true;
            } else {
                isRotating = true;
            }
            previousMousePosition = { x: event.clientX, y: event.clientY };
        }
    });
    
    renderer.domElement.addEventListener('mousemove', (event) => {
        if (isRotating && !isPanning) {
            const deltaX = event.clientX - previousMousePosition.x;
            const deltaY = event.clientY - previousMousePosition.y;
            
            const rotationSpeed = 0.005;
            const spherical = new THREE.Spherical();
            spherical.setFromVector3(camera.position.clone().sub(cameraTarget));
            spherical.theta -= deltaX * rotationSpeed;
            spherical.phi += deltaY * rotationSpeed;
            spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, spherical.phi));
            
            camera.position.setFromSpherical(spherical).add(cameraTarget);
            camera.lookAt(cameraTarget);
            
            previousMousePosition = { x: event.clientX, y: event.clientY };
        } else if (isPanning) {
            const deltaX = event.clientX - previousMousePosition.x;
            const deltaY = event.clientY - previousMousePosition.y;
            
            const panSpeed = 0.02;
            const right = new THREE.Vector3();
            const up = new THREE.Vector3();
            
            camera.getWorldDirection(right);
            right.cross(camera.up).normalize();
            up.copy(camera.up);
            
            const panVector = new THREE.Vector3();
            panVector.addScaledVector(right, -deltaX * panSpeed);
            panVector.addScaledVector(up, deltaY * panSpeed);
            
            camera.position.add(panVector);
            cameraTarget.add(panVector);
            camera.lookAt(cameraTarget);
            
            previousMousePosition = { x: event.clientX, y: event.clientY };
        }
    });
    
    renderer.domElement.addEventListener('mouseup', () => {
        isRotating = false;
        isPanning = false;
    });
    
    renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
}

function setupEventListeners() {
    renderer.domElement.addEventListener('mousedown', onMouseDown);
    renderer.domElement.addEventListener('mousemove', onMouseMove);
    renderer.domElement.addEventListener('mouseup', onMouseUp);
    
    document.getElementById('selectBtn').addEventListener('click', () => {
        currentTool = 'select';
        updateToolButtons();
    });
    
    document.getElementById('saveStructureBtn').addEventListener('click', saveSelectedStructure);
    
    // Snap to default isometric view
    const isoBtn = document.getElementById('isoViewBtn');
    if (isoBtn) {
        isoBtn.addEventListener('click', () => snapSceneCameraToDefaultIso());
    }
    
    window.addEventListener('resize', onWindowResize);
    
    // Keyboard events
    window.addEventListener('keydown', (event) => {
        if (event.key === 'Shift') {
            shiftPressed = true;
            if (selectedVoxels.length > 0) {
                createGizmos();
            }
        } else if (event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault();
            clearSelection();
            hideGizmos();
        } else if (event.key === 'f' || event.key === 'F') {
            event.preventDefault();
            toggleFocusMode();
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            deleteSelectedVoxels();
        }
    });
    
    window.addEventListener('keyup', (event) => {
        if (event.key === 'Shift') {
            shiftPressed = false;
            if (!isDraggingGizmo) {
                hideGizmos();
            }
        }
    });
    
    // Grid size slider events
    const gridXSlider = document.getElementById('gridXSlider');
    const gridXValue = document.getElementById('gridXValue');
    const gridZSlider = document.getElementById('gridZSlider');
    const gridZValue = document.getElementById('gridZValue');
    
    gridXSlider.addEventListener('input', (event) => {
        gridSizeX = parseInt(event.target.value);
        gridXValue.textContent = gridSizeX;
        createGroundGrid();
        clearSelection();
        hideGizmos();
    });
    
    gridZSlider.addEventListener('input', (event) => {
        gridSizeZ = parseInt(event.target.value);
        gridZValue.textContent = gridSizeZ;
        createGroundGrid();
        clearSelection();
        hideGizmos();
    });
    
    // Height slider events
    const heightSlider = document.getElementById('heightSlider');
    const heightValue = document.getElementById('heightValue');
    
    heightSlider.addEventListener('input', (event) => {
        heightLimit = parseInt(event.target.value);
        heightValue.textContent = heightLimit;
        updateAllVoxelColors();
    });
    
    // Buildify menu events
    setupBuildifyEvents();
}

function updateToolButtons() {
    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    if (currentTool === 'select') {
        document.getElementById('selectBtn').classList.add('active');
    }
}

function onMouseDown(event) {
    if (event.button === 2) return; // Ignore right click for rotation
    
    const container = document.getElementById('scene-container');
    const rect = container.getBoundingClientRect();
    
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    
    raycaster.setFromCamera(mouse, camera);
    
    // Check for gizmo intersection only if shift is held and gizmo is visible
    if (shiftPressed && gizmoGroup.children.length > 0) {
        const gizmoIntersects = raycaster.intersectObjects(gizmoGroup.children, true);
        if (gizmoIntersects.length > 0) {
            const gizmoObject = gizmoIntersects[0].object.parent || gizmoIntersects[0].object;
            startGizmoDrag(gizmoObject, event);
            return;
        }
    }
    
    // Check for voxel selection
    const allObjects = [...groundGrid.flat(), ...voxels];
    const intersects = raycaster.intersectObjects(allObjects);
    
    if (intersects.length > 0) {
        const object = intersects[0].object;
        // Default behavior is now multi-select (toggle)
        toggleSelection(object);
        
        // Only update gizmos if shift is pressed
        if (shiftPressed && selectedVoxels.length > 0) {
            createGizmos();
        }
    }
}

function onMouseMove(event) {
    if (!isDraggingGizmo) return;
    
    const container = document.getElementById('scene-container');
    const rect = container.getBoundingClientRect();
    
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    
    updateDragPreview(event);
}

function onMouseUp(event) {
    if (isDraggingGizmo) {
        finishGizmoDrag();
    }
}

function toggleSelection(object) {
    if (object.userData.isGizmo) return;
    
    const index = selectedVoxels.indexOf(object);
    
    if (index === -1) {
        selectedVoxels.push(object);
        object.userData.selected = true;
        object.material.emissiveIntensity = 0.3;
        object.material.emissive = new THREE.Color(0x4444ff);
    } else {
        selectedVoxels.splice(index, 1);
        object.userData.selected = false;
        object.material.emissiveIntensity = 0;
    }
}

function clearSelection() {
    selectedVoxels.forEach(voxel => {
        voxel.userData.selected = false;
        voxel.material.emissiveIntensity = 0;
    });
    selectedVoxels = [];
    hideGizmos();
}


function createGizmos() {
    hideGizmos();
    
    if (selectedVoxels.length === 0) return;
    
    const bounds = new THREE.Box3();
    selectedVoxels.forEach(voxel => {
        bounds.expandByObject(voxel);
    });
    
    const center = new THREE.Vector3();
    bounds.getCenter(center);
    
    const arrowLength = 3;
    const arrowHeadLength = 1;
    const arrowHeadWidth = 0.5;
    
    const xArrow = new THREE.ArrowHelper(
        new THREE.Vector3(1, 0, 0),
        center,
        arrowLength,
        0xff0000,
        arrowHeadLength,
        arrowHeadWidth
    );
    xArrow.userData = { isGizmo: true, axis: 'x' };
    
    const yArrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0),
        center,
        arrowLength,
        0x00ff00,
        arrowHeadLength,
        arrowHeadWidth
    );
    yArrow.userData = { isGizmo: true, axis: 'y' };
    
    const zArrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 0, 1),
        center,
        arrowLength,
        0x0000ff,
        arrowHeadLength,
        arrowHeadWidth
    );
    zArrow.userData = { isGizmo: true, axis: 'z' };
    
    const negXArrow = new THREE.ArrowHelper(
        new THREE.Vector3(-1, 0, 0),
        center,
        arrowLength,
        0x880000,
        arrowHeadLength,
        arrowHeadWidth
    );
    negXArrow.userData = { isGizmo: true, axis: 'x', negative: true };
    
    const negYArrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, -1, 0),
        center,
        arrowLength,
        0x008800,
        arrowHeadLength,
        arrowHeadWidth
    );
    negYArrow.userData = { isGizmo: true, axis: 'y', negative: true };
    
    const negZArrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 0, -1),
        center,
        arrowLength,
        0x000088,
        arrowHeadLength,
        arrowHeadWidth
    );
    negZArrow.userData = { isGizmo: true, axis: 'z', negative: true };
    
    gizmoGroup.add(xArrow, yArrow, zArrow, negXArrow, negYArrow, negZArrow);
}

function hideGizmos() {
    while(gizmoGroup.children.length > 0) {
        gizmoGroup.remove(gizmoGroup.children[0]);
    }
}

function getHeightBasedColor(baseColor, yPosition) {
    // Calculate darkness factor based on Y position (0 at ground, 1 at heightLimit)
    const heightFactor = Math.max(0, Math.min(1, yPosition / heightLimit));
    
    // Convert hex color to RGB
    const color = new THREE.Color(baseColor);
    
    // Apply darkness factor (multiply by 1 - heightFactor)
    const darkness = 1 - heightFactor;
    color.multiplyScalar(darkness);
    
    return color;
}

function updateVoxelColor(voxel) {
    const baseColor = voxel.userData.baseColor || 0xe0e0e0;
    const newColor = getHeightBasedColor(baseColor, voxel.position.y);
    voxel.material.color.copy(newColor);
}

function updateAllVoxelColors() {
    // Update ground grid colors
    groundGrid.flat().forEach(voxel => {
        updateVoxelColor(voxel);
    });
    
    // Update created voxel colors
    voxels.forEach(voxel => {
        updateVoxelColor(voxel);
    });
}

function toggleFocusMode() {
    if (!focusMode) {
        // Enter focus mode - only allow if a structure is loaded
        if (!focusedStructure) {
            alert('Load a saved structure first to enter focus mode!');
            return;
        }
        
        enterFocusMode();
    } else {
        // Exit focus mode
        exitFocusMode();
    }
}

function enterFocusMode() {
    focusMode = true;
    
    // Initialize the focused structure voxels set with current structure voxels
    focusedStructureVoxels.clear();
    
    // Find all voxels that belong to the focused structure
    focusedStructure.data.forEach(voxelData => {
        const targetPos = new THREE.Vector3().fromArray(voxelData.position);
        targetPos.x = Math.round(targetPos.x);
        targetPos.y = Math.round(targetPos.y);
        targetPos.z = Math.round(targetPos.z);
        
        const allObjects = [...groundGrid.flat(), ...voxels];
        const matchingVoxel = allObjects.find(voxel => {
            const voxelPos = voxel.position;
            return Math.abs(voxelPos.x - targetPos.x) < 0.1 && 
                   Math.abs(voxelPos.y - targetPos.y) < 0.1 && 
                   Math.abs(voxelPos.z - targetPos.z) < 0.1;
        });
        
        if (matchingVoxel) {
            focusedStructureVoxels.add(matchingVoxel);
        }
    });
    
    // Select all structure voxels
    clearSelection();
    focusedStructureVoxels.forEach(voxel => {
        toggleSelection(voxel);
    });
    
    // Update visibility - hide all non-structure voxels
    updateFocusModeVisibility();
    
    // Show focus indicator
    const indicator = document.getElementById('focusIndicator');
    indicator.style.display = 'block';
    
    // Show Buildify menu
    const buildifyMenu = document.getElementById('buildify-menu');
    buildifyMenu.style.display = 'flex';
    
    console.log('Entered focus mode for structure:', focusedStructure.name);
}

function exitFocusMode() {
    focusMode = false;

    // If procedural building is shown, clear and reset toggle
    try {
        const toggle = document.getElementById('toggleRenderBuilding');
        if (toggle && toggle.checked) {
            toggle.checked = false;
        }
    } catch {}
    renderBuildingEnabled = false;
    restoreOriginalFocusedStructure();

    // Update the focused structure with all current structure voxels
    updateFocusedStructure();
    
    // Restore all voxels to full visibility
    const allVoxels = [...groundGrid.flat(), ...voxels];
    allVoxels.forEach(voxel => {
        voxel.visible = true;
        
        // Also restore edge visibility
        if (voxel.userData.edges) {
            voxel.userData.edges.visible = true;
        }
    });
    
    // Hide focus indicator
    const indicator = document.getElementById('focusIndicator');
    indicator.style.display = 'none';
    
    // Hide Buildify menu
    const buildifyMenu = document.getElementById('buildify-menu');
    buildifyMenu.style.display = 'none';
    
    // Keep structure voxels selected
    clearSelection();
    focusedStructureVoxels.forEach(voxel => {
        toggleSelection(voxel);
    });
    
    console.log('Exited focus mode, updated structure with', focusedStructureVoxels.size, 'voxels');
}

function updateFocusModeVisibility() {
    if (!focusMode) return;
    
    const allVoxels = [...groundGrid.flat(), ...voxels];
    allVoxels.forEach(voxel => {
        // Show only voxels that are part of the focused structure
        const isVisible = focusedStructureVoxels.has(voxel);
        voxel.visible = isVisible;
        
        // Also update edge visibility
        if (voxel.userData.edges) {
            voxel.userData.edges.visible = isVisible;
        }
    });
}

function addVoxelToFocusedStructure(voxel) {
    if (focusMode && voxel && !focusedStructureVoxels.has(voxel)) {
        focusedStructureVoxels.add(voxel);
        voxel.visible = true;
        
        // Also make edges visible
        if (voxel.userData.edges) {
            voxel.userData.edges.visible = true;
        }
    }
}

function updateFocusedStructure() {
    if (!focusedStructure || focusedStructureVoxels.size === 0) return;
    
    // Update the structure data with all focused structure voxels
    const structureData = Array.from(focusedStructureVoxels).map(voxel => ({
        position: voxel.position.toArray(),
        color: voxel.userData.baseColor || voxel.material.color.getHex(),
        size: voxelSize
    }));
    
    focusedStructure.data = structureData;
    
    // Find and update in savedStructures array
    const structureIndex = savedStructures.findIndex(s => s.id === focusedStructure.id);
    if (structureIndex !== -1) {
        savedStructures[structureIndex] = focusedStructure;
        updateStructuresMenu();
    }
}

function deleteSelectedVoxels() {
    if (selectedVoxels.length === 0) return;
    
    // Can't delete ground grid voxels
    const voxelsToDelete = selectedVoxels.filter(voxel => voxel.userData.type !== 'ground');
    
    if (voxelsToDelete.length === 0) {
        console.log('Cannot delete ground grid voxels');
        return;
    }
    
    voxelsToDelete.forEach(voxel => {
        // Remove from scene
        scene.remove(voxel);
        
        // Remove edges if they exist
        if (voxel.userData.edges) {
            scene.remove(voxel.userData.edges);
            if (voxel.userData.edges.geometry) voxel.userData.edges.geometry.dispose();
            if (voxel.userData.edges.material) voxel.userData.edges.material.dispose();
        }
        
        // Dispose of geometry and material
        if (voxel.geometry) voxel.geometry.dispose();
        if (voxel.material) voxel.material.dispose();
        
        // Remove from voxels array
        const voxelIndex = voxels.indexOf(voxel);
        if (voxelIndex > -1) {
            voxels.splice(voxelIndex, 1);
        }
        
        // Remove from focused structure if in focus mode
        if (focusMode && focusedStructureVoxels.has(voxel)) {
            focusedStructureVoxels.delete(voxel);
        }
        
        // Remove from selected voxels
        const selectedIndex = selectedVoxels.indexOf(voxel);
        if (selectedIndex > -1) {
            selectedVoxels.splice(selectedIndex, 1);
        }
    });
    
    // Update gizmos after deletion
    updateGizmos();
    
    console.log('Deleted', voxelsToDelete.length, 'voxels');
}

function setupBuildifyEvents() {
    const closeBuildify = document.getElementById('closeBuildify');
    const captureBtn = document.getElementById('captureStructureBtn');

    if (closeBuildify) {
        closeBuildify.addEventListener('click', () => {
            const buildifyMenu = document.getElementById('buildify-menu');
            buildifyMenu.style.display = 'none';
        });
    }

    if (captureBtn) {
        captureBtn.addEventListener('click', async () => {
            await handleCaptureStructure();
        });
    }
}

async function handleCaptureStructure() {
    try {
        if (!focusedStructure) {
            alert('No active structure. Load a structure first.');
            return;
        }

        const structureVoxels = collectVoxelsForStructure(focusedStructure);
        if (structureVoxels.size === 0) {
            alert('Could not find voxels for the active structure in the scene.');
            return;
        }
        const bounds = computeBoundsForVoxelSet(structureVoxels);

        const { restore } = isolateForCapture(structureVoxels);

        const width = 512;
        const height = 512;

        // Top-down orthographic
        const orthoTop = createOrthoCameraToFit(bounds, width, height, 'top');
        const topDataUrl = renderToDataURL(orthoTop, width, height, { clearColor: 0xffffff });

        // Front orthographic
        const orthoFront = createOrthoCameraToFit(bounds, width, height, 'front');
        const frontDataUrl = renderToDataURL(orthoFront, width, height, { clearColor: 0xffffff });

        // Ortho depth at the same default iso angles as the viewer
        const orthoOblique = createOrthoObliqueCameraToFit(bounds, width, height, DEFAULT_ISO_ELEVATION_DEG, DEFAULT_ISO_AZIMUTH_DEG);
        orthoOblique.updateMatrixWorld(true);
        const { nearZ, farZ } = computeDepthRangeForSet(structureVoxels, orthoOblique);
        const depthMaterial = createLinearDepthMaterial(nearZ, farZ, true, 1.0, 32);
        const depthDataUrl = renderToDataURL(orthoOblique, width, height, { overrideMaterial: depthMaterial, clearColor: 0x000000 });
        depthMaterial.dispose();

        restore();

        displayCapturedImages([
            { label: 'Top-down', dataUrl: topDataUrl },
            { label: 'Frontal', dataUrl: frontDataUrl },
            { label: 'Iso Ortho Depth', dataUrl: depthDataUrl }
        ]);
    } catch (e) {
        console.error('Capture failed:', e);
        alert('Capture failed. See console for details.');
    }
}

function displayCapturedImages(images) {
    const gallery = document.getElementById('captureGallery');
    if (!gallery) return;
    gallery.innerHTML = '';
    images.forEach(img => {
        const item = document.createElement('div');
        item.className = 'capture-item';
        item.innerHTML = `
            <div class="capture-label">${img.label}</div>
            <img class="capture-img" src="${img.dataUrl}" alt="${img.label}">
        `;
        gallery.appendChild(item);
    });
}

function collectVoxelsForStructure(structure) {
    const set = new Set();
    const allObjects = [...groundGrid.flat(), ...voxels];
    structure.data.forEach(voxelData => {
        const targetPos = new THREE.Vector3().fromArray(voxelData.position);
        targetPos.x = Math.round(targetPos.x);
        targetPos.y = Math.round(targetPos.y);
        targetPos.z = Math.round(targetPos.z);
        const matchingVoxel = allObjects.find(voxel => {
            const p = voxel.position;
            return Math.abs(p.x - targetPos.x) < 0.1 && Math.abs(p.y - targetPos.y) < 0.1 && Math.abs(p.z - targetPos.z) < 0.1;
        });
        if (matchingVoxel) set.add(matchingVoxel);
    });
    return set;
}

function computeBoundsForVoxelSet(voxelSet) {
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    voxelSet.forEach(v => {
        const p = v.position;
        min.x = Math.min(min.x, Math.round(p.x));
        min.y = Math.min(min.y, Math.round(p.y));
        min.z = Math.min(min.z, Math.round(p.z));
        max.x = Math.max(max.x, Math.round(p.x));
        max.y = Math.max(max.y, Math.round(p.y));
        max.z = Math.max(max.z, Math.round(p.z));
    });
    return { min, max };
}

function createOrthoCameraToFit(bounds, width, height, orientation) {
    const aspect = width / height;
    const center = new THREE.Vector3().addVectors(bounds.min, bounds.max).multiplyScalar(0.5);
    const sizeX = Math.max(1, bounds.max.x - bounds.min.x + 1);
    const sizeY = Math.max(1, bounds.max.y - bounds.min.y + 1);
    const sizeZ = Math.max(1, bounds.max.z - bounds.min.z + 1);
    const margin = 1;

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);

    if (orientation === 'top') {
        const halfW = sizeX / 2 + margin;
        const halfH = sizeZ / 2 + margin;
        const scale = Math.max(halfH, halfW / aspect);
        camera.left = -scale * aspect;
        camera.right = scale * aspect;
        camera.top = scale;
        camera.bottom = -scale;
        camera.position.set(center.x, bounds.max.y + 50, center.z);
        camera.up.set(0, 0, -1);
        camera.lookAt(center);
    } else if (orientation === 'front') {
        const halfW = sizeX / 2 + margin;
        const halfH = sizeY / 2 + margin;
        const scale = Math.max(halfH, halfW / aspect);
        camera.left = -scale * aspect;
        camera.right = scale * aspect;
        camera.top = scale;
        camera.bottom = -scale;
        camera.position.set(center.x, center.y, bounds.max.z + 50);
        camera.up.set(0, 1, 0);
        camera.lookAt(center);
    }

    camera.updateProjectionMatrix();
    return camera;
}

// Create an oblique orthographic camera at a given elevation/azimuth that tightly fits the bounds
function createOrthoObliqueCameraToFit(bounds, width, height, elevationDeg = 30, azimuthDeg = 45) {
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);

    const center = new THREE.Vector3().addVectors(bounds.min, bounds.max).multiplyScalar(0.5);
    const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
    const radius = Math.max(1, size.length() * 0.5);

    const elev = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);

    // Position camera using same convention as the viewer (front-facing iso)
    const distance = radius * 4;
    const px = center.x + distance * Math.cos(elev) * Math.cos(az);
    const py = center.y + distance * Math.sin(elev);
    const pz = center.z + distance * Math.cos(elev) * Math.sin(az);
    camera.position.set(px, py, pz);

    // Derive forward direction and a robust up vector
    const dir = center.clone().sub(camera.position).normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const initialUp = Math.abs(worldUp.dot(dir)) > 0.99 ? new THREE.Vector3(0, 0, 1) : worldUp.clone();
    camera.up.copy(initialUp);
    camera.lookAt(center);

    // Keep upright orientation
    if (camera.up.dot(worldUp) < 0) {
        camera.up.negate();
        camera.lookAt(center);
    }

    camera.updateMatrixWorld(true);

    // Transform the 8 corners into view space to compute tight x/y extents and depth range
    const inv = new THREE.Matrix4().copy(camera.matrixWorld).invert();
    const corners = [];
    for (let xi of [bounds.min.x, bounds.max.x]) {
        for (let yi of [bounds.min.y, bounds.max.y]) {
            for (let zi of [bounds.min.z, bounds.max.z]) {
                corners.push(new THREE.Vector3(xi, yi, zi));
            }
        }
    }

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const c of corners) {
        const v = c.clone().applyMatrix4(inv);
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
        const viewZ = -v.z; // forward distance
        minZ = Math.min(minZ, viewZ); maxZ = Math.max(maxZ, viewZ);
    }

    // Center and expand to match render aspect so the whole model fits, with margin
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const halfW0 = (maxX - minX) * 0.5;
    const halfH0 = (maxY - minY) * 0.5;
    const margin = 0.75;
    const targetAspect = width / height;

    let halfH = Math.max(halfH0 + margin, (halfW0 + margin) / targetAspect);
    let halfW = halfH * targetAspect;

    camera.left = cx - halfW;
    camera.right = cx + halfW;
    camera.bottom = cy - halfH;
    camera.top = cy + halfH;
    camera.near = Math.max(0.001, minZ - 1.0);
    camera.far = maxZ + 1.0;
    camera.updateProjectionMatrix();

    return camera;
}

function createPerspectiveCameraToFit(bounds, width, height, elevationDeg = 30, azimuthDeg = 45) {
    const aspect = width / height;
    const fov = 40;
    const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 5000);

    const center = new THREE.Vector3().addVectors(bounds.min, bounds.max).multiplyScalar(0.5);
    const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
    const radius = Math.max(1, size.length() / 2);

    const distance = radius / Math.tan(THREE.MathUtils.degToRad(fov / 2)) + radius;
    const elev = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);

    const x = center.x + distance * Math.cos(elev) * Math.cos(az);
    const y = center.y + distance * Math.sin(elev);
    const z = center.z + distance * Math.cos(elev) * Math.sin(az);

    camera.position.set(x, y, z);
    camera.lookAt(center);
    camera.near = Math.max(0.1, distance - radius * 2);
    camera.far = distance + radius * 2;
    camera.updateProjectionMatrix();

    return camera;
}

function renderToDataURL(camera, width, height, { overrideMaterial = null, clearColor = null } = {}) {
    const target = new THREE.WebGLRenderTarget(width, height, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType });

    // Force linear color for the render target where possible (support both pre- and post-r152)
    if (target.texture && 'colorSpace' in target.texture) {
        target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    } else if (target.texture && 'encoding' in target.texture) {
        target.texture.encoding = THREE.LinearEncoding;
    }

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevTone = renderer.toneMapping;

    // Preserve and switch to linear output for this offscreen pass
    const hadColorSpace = ('outputColorSpace' in renderer);
    const hadEncoding = ('outputEncoding' in renderer);
    let prevCS = null;
    let prevEnc = null;
    if (hadColorSpace) {
        prevCS = renderer.outputColorSpace;
        renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    } else if (hadEncoding) {
        prevEnc = renderer.outputEncoding;
        renderer.outputEncoding = THREE.LinearEncoding;
    }

    if (clearColor !== null) {
        renderer.setClearColor(clearColor, 1);
    }

    scene.overrideMaterial = overrideMaterial;

    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);

    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);

    // Flip Y when copying
    for (let y = 0; y < height; y++) {
        const srcStart = (height - 1 - y) * width * 4;
        const destStart = y * width * 4;
        imageData.data.set(pixels.subarray(srcStart, srcStart + width * 4), destStart);
    }

    ctx.putImageData(imageData, 0, 0);

    // Restore
    renderer.setRenderTarget(prevTarget);
    scene.overrideMaterial = prevOverride;
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.toneMapping = prevTone;
    if (hadColorSpace) {
        renderer.outputColorSpace = prevCS;
    } else if (hadEncoding) {
        renderer.outputEncoding = prevEnc;
    }

    target.dispose();

    return canvas.toDataURL('image/png');
}

function isolateForCapture(structureVoxels) {
    const toRestore = [];

    // Hide grid helpers/planes
    scene.children.forEach(child => {
        const isGrid = child.userData && (child.userData.isGridHelper || child.userData.isGridPlane);
        if (isGrid && child.visible) {
            toRestore.push(child);
            child.visible = false;
        }
    });

    const all = [...groundGrid.flat(), ...voxels];
    all.forEach(v => {
        const inSet = structureVoxels.has(v);
        if (!inSet && v.visible) {
            toRestore.push(v);
            v.visible = false;
        }
        if (v.userData && v.userData.edges && v.userData.edges.visible) {
            toRestore.push(v.userData.edges);
            v.userData.edges.visible = false;
        }
    });

    return {
        restore() {
            toRestore.forEach(o => { o.visible = true; });
        }
    };
}

function snapshotOriginalFocusedStructure() {
    if (!focusedStructure || focusedStructureVoxels.size === 0) return;
    originalStructureSnapshot = Array.from(focusedStructureVoxels).map(v => ({
        position: v.position.clone(),
        color: v.userData.baseColor || v.material.color.getHex(),
    }));
}

function clearBuildingInstances() {
    if (buildingInstanceGroup) {
        scene.remove(buildingInstanceGroup);
        // Dispose instance group children
        while (buildingInstanceGroup.children.length) {
            const child = buildingInstanceGroup.children.pop();
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        }
    }
    buildingInstanceGroup = null;
}

function restoreOriginalFocusedStructure() {
    clearBuildingInstances();
    if (!originalStructureSnapshot) return;

    // Show original voxels
    focusedStructureVoxels.forEach(v => {
        v.visible = true;
        if (v.userData.edges) v.userData.edges.visible = true;
    });
}

function hideOriginalFocusedStructure() {
    focusedStructureVoxels.forEach(v => {
        v.visible = false;
        if (v.userData.edges) v.userData.edges.visible = false;
    });
}

function regenerateProceduralBuilding() {
    if (!focusedStructure || focusedStructureVoxels.size === 0) return;
    clearBuildingInstances();
    hideOriginalFocusedStructure();

    const params = getBuildParams();
    const bounds = computeFocusedStructureBounds();

    buildingInstanceGroup = new THREE.Group();
    buildingInstanceGroup.userData.isProceduralBuilding = true;
    scene.add(buildingInstanceGroup);

    // Geometry and materials
    const sub = params.subdivisions;
    const unit = voxelSize / sub;
    const baseGeom = new THREE.BoxGeometry(unit, unit, unit);
    const wallMat = new THREE.MeshPhongMaterial({ color: 0x9b6a5d, emissive: 0x000000, shininess: 10 });
    const wallAltMat = new THREE.MeshPhongMaterial({ color: 0x8d5f52, emissive: 0x000000, shininess: 10 });
    const frameMat = new THREE.MeshPhongMaterial({ color: 0x5a5a5a, emissive: 0x000000 });
    const glassMat = new THREE.MeshPhysicalMaterial({ color: 0xa0c8ff, metalness: 0, roughness: 0.18, transmission: 0.6, transparent: true, opacity: 0.85 });
    const lightMat = new THREE.MeshPhongMaterial({ color: 0xfff3b0, emissive: 0xfff3b0, emissiveIntensity: 1.5 });
    const roofMat = new THREE.MeshPhongMaterial({ color: 0x333333 });

    // Per-material instanced meshes
    const wallMesh = new THREE.InstancedMesh(baseGeom, wallMat, 1e6);
    const wallAltMesh = new THREE.InstancedMesh(baseGeom, wallAltMat, 5e5);
    const frameMesh = new THREE.InstancedMesh(baseGeom, frameMat, 5e5);
    const glassMesh = new THREE.InstancedMesh(baseGeom, glassMat, 5e5);
    const lightMesh = new THREE.InstancedMesh(baseGeom, lightMat, 3e5);
    const roofMesh = new THREE.InstancedMesh(baseGeom, roofMat, 2e5);
    wallMesh.count = 0; wallAltMesh.count = 0; frameMesh.count = 0; glassMesh.count = 0; lightMesh.count = 0; roofMesh.count = 0;

    buildingInstanceGroup.add(wallMesh);
    buildingInstanceGroup.add(wallAltMesh);
    buildingInstanceGroup.add(frameMesh);
    buildingInstanceGroup.add(glassMesh);
    buildingInstanceGroup.add(lightMesh);
    buildingInstanceGroup.add(roofMesh);

    const dummy = new THREE.Object3D();

    const floorsPerSeg = params.floorsPerSegment;

    // Preserve original height exactly: total floors are (height segments * floorsPerSegment)
    const heightSegments = Math.round(bounds.max.y - bounds.min.y + 1);
    const totalFloors = heightSegments * floorsPerSeg;

    // Derive floor banding within each segment: use subgrid to split floors
    // floorBand = sub / floorsPerSeg; Each floor occupies floorBand sub-voxels in Y
    const floorBand = Math.max(1, Math.floor(sub / Math.max(1, floorsPerSeg)));

    // Exterior footprint cells and window column layout per direction
    const exteriorCells = computeExteriorCells(bounds);
    const layout = computeFacadeLayouts(bounds, sub, params);

    // Pass 1: structural shell with apertures, frames, glass/lights
    for (const cell of exteriorCells) {
        const baseWorldX = cell.x;
        const baseWorldZ = cell.z;

        for (let segY = 0; segY < heightSegments; segY++) {
            for (let floorInSeg = 0; floorInSeg < floorsPerSeg; floorInSeg++) {
                for (let sy = 0; sy < floorBand; sy++) {
                    const globalFloorIndex = segY * floorsPerSeg + floorInSeg;

                    for (let sx = 0; sx < sub; sx++) {
                        for (let sz = 0; sz < sub; sz++) {
                            const isShell = (sx === 0 || sx === sub - 1 || sz === 0 || sz === sub - 1 || sy === 0 || sy === floorBand - 1);
                            if (!isShell) continue;

                            const worldX = baseWorldX + (sx + 0.5) / sub;
                            const worldY = Math.floor(bounds.min.y) + segY + (floorInSeg * floorBand + sy + 0.5) / sub;
                            const worldZ = baseWorldZ + (sz + 0.5) / sub;

                            let face = null;
                            if (sx === 0) face = 'x-'; else if (sx === sub - 1) face = 'x+'; else if (sz === 0) face = 'z-'; else if (sz === sub - 1) face = 'z+';

                            const openResult = computeOpeningWithLayout(params, layout, face, globalFloorIndex, sx, sy, sz, sub, floorBand);

                            dummy.position.set(worldX, worldY, worldZ);
                            dummy.updateMatrix();

                            const isRoofLayer = (segY === heightSegments - 1) && (floorInSeg === floorsPerSeg - 1) && (sy === floorBand - 1);

                            if (!face) {
                                // roof/floor slab
                                if (isRoofLayer) {
                                    roofMesh.setMatrixAt(roofMesh.count++, dummy.matrix);
                                } else {
                                    wallMesh.setMatrixAt(wallMesh.count++, dummy.matrix);
                                }
                            } else if (openResult.open) {
                                const lit = openResult.lit;
                                const target = lit ? lightMesh : glassMesh;
                                target.setMatrixAt((lit ? lightMesh : glassMesh).count++, dummy.matrix);
                            } else if (openResult.frame) {
                                frameMesh.setMatrixAt(frameMesh.count++, dummy.matrix);
                            } else {
                                const alt = pseudoNoise(worldX * 19 + worldY * 7 + worldZ * 13) > 0.95;
                                (alt ? wallAltMesh : wallMesh).setMatrixAt(alt ? wallAltMesh.count++ : wallMesh.count++, dummy.matrix);
                            }
                        }
                    }
                }
            }
        }
    }

    // Pass 2: cornice band and simple roof details
    addCorniceBand(bounds, sub, heightSegments, floorsPerSeg, floorBand, frameMesh);
    addSimpleRoofDetails(bounds, sub, roofMesh, frameMesh);

    wallMesh.instanceMatrix.needsUpdate = true;
    wallAltMesh.instanceMatrix.needsUpdate = true;
    frameMesh.instanceMatrix.needsUpdate = true;
    glassMesh.instanceMatrix.needsUpdate = true;
    lightMesh.instanceMatrix.needsUpdate = true;
    roofMesh.instanceMatrix.needsUpdate = true;
}

function computeFacadeLayouts(bounds, sub, params) {
    // Calculate consistent window column spacing per facade based on width/depth
    const width = Math.round(bounds.max.x - bounds.min.x + 1);
    const depth = Math.round(bounds.max.z - bounds.min.z + 1);
    const frameThickness = 1; // in sub-voxels per segment side
    const windowW = Math.max(1, Math.min(params.windowWidthSub, Math.floor(sub / 2)));
    const gap = Math.max(1, Math.floor(sub / Math.max(2, params.windowDensity * 2)));

    function calc(length) {
        const content = sub - 2 * frameThickness; // interior width per segment
        // approximate columns per segment from density
        const perSegCols = Math.max(1, Math.floor(content / (windowW + gap)));
        return { perSegCols, windowW, gap, frameThickness };
    }
    return {
        north: calc(width),
        south: calc(width),
        east: calc(depth),
        west: calc(depth)
    };
}

function computeOpeningWithLayout(params, layout, face, globalFloorIndex, sx, sy, sz, sub, floorBand) {
    if (!face) return { open: false, frame: false, lit: false };

    const side = face === 'z-' ? 'north' : face === 'z+' ? 'south' : face === 'x-' ? 'west' : 'east';
    const conf = layout[side];

    // vertical bands within a floor band for window height
    const sill = Math.floor(0.15 * floorBand);
    const lintel = Math.floor(floorBand - Math.max(1, Math.floor((floorBand - params.windowHeightSub) / 2)));
    const withinWindowBand = sy >= sill && sy < lintel;

    // map to repeated per-segment columns using perSegCols and gap
    const cellSpan = conf.windowW + conf.gap;
    const local = face.startsWith('x') ? sz : sx; // choose lateral sub-voxel coordinate
    const offset = conf.frameThickness;
    const localContent = Math.max(0, local - offset);
    const inContent = local >= offset && local < sub - offset;

    let inWindowColumn = false;
    if (inContent) {
        const columnIndex = Math.floor(localContent / cellSpan);
        const columnStart = columnIndex * cellSpan;
        const withinWindowWidth = (localContent - columnStart) < conf.windowW;
        inWindowColumn = withinWindowWidth;
    }

    // Exactness toggles stochastic openings adherence
    const open = withinWindowBand && inWindowColumn && (pseudoNoise(globalFloorIndex * 97 + sx * 31 + sz * 13) <= params.exactShape);
    const frame = withinWindowBand && !open && (inContent && ((localContent % cellSpan === 0) || ((localContent + conf.windowW) % cellSpan === 0)));
    const lit = open && (pseudoNoise(globalFloorIndex * 131 + sx * 17 + sz * 23) > 0.6);

    // Style shaping (arched top)
    if (open && params.windowStyle === 'arched') {
        const relativeY = sy - sill;
        const height = Math.max(1, lintel - sill);
        const archTop = height;
        const center = Math.floor(sub / 2);
        const lateral = face.startsWith('x') ? sz : sx;
        const dx = Math.abs(lateral - center);
        const maxDx = Math.max(1, Math.floor(conf.windowW / 2));
        const archLimit = Math.floor(archTop - (dx / maxDx) * archTop);
        if (relativeY > archLimit) {
            return { open: false, frame: true, lit: false };
        }
    }

    return { open, frame, lit };
}

function addCorniceBand(bounds, sub, heightSegments, floorsPerSeg, floorBand, frameMesh) {
    const dummy = new THREE.Object3D();
    const { min, max } = bounds;
    const yLayer = Math.floor(min.y) + heightSegments - 1 + (floorsPerSeg * floorBand - 1) / sub;

    for (let x = Math.floor(min.x); x <= Math.floor(max.x); x++) {
        for (let z = Math.floor(min.z); z <= Math.floor(max.z); z++) {
            const atEdge = (x === Math.floor(min.x) || x === Math.floor(max.x) || z === Math.floor(min.z) || z === Math.floor(max.z));
            if (!atEdge) continue;
            for (let sx = 0; sx < sub; sx++) {
                for (let sz = 0; sz < sub; sz++) {
                    const worldX = x + (sx + 0.5) / sub;
                    const worldY = yLayer;
                    const worldZ = z + (sz + 0.5) / sub;
                    dummy.position.set(worldX, worldY, worldZ);
                    dummy.updateMatrix();
                    frameMesh.setMatrixAt(frameMesh.count++, dummy.matrix);
                }
            }
        }
    }
}

function addSimpleRoofDetails(bounds, sub, roofMesh, frameMesh) {
    const dummy = new THREE.Object3D();
    const { min, max } = bounds;
    const y = Math.floor(min.y) + Math.round(max.y - min.y + 1) - 1 + (0.9 / sub);

    // Sparse vents and AC units inside a margin
    const margin = 1;
    for (let x = Math.floor(min.x) + margin; x <= Math.floor(max.x) - margin; x++) {
        for (let z = Math.floor(min.z) + margin; z <= Math.floor(max.z) - margin; z++) {
            if (pseudoNoise(x * 31 + z * 17) > 0.98) {
                // small vent
                dummy.position.set(x + 0.5, y, z + 0.5);
                dummy.updateMatrix();
                frameMesh.setMatrixAt(frameMesh.count++, dummy.matrix);
            }
            if (pseudoNoise(x * 13 + z * 47) > 0.995) {
                // AC block (2x2 footprint)
                for (let dx = 0; dx < 2; dx++) for (let dz = 0; dz < 2; dz++) {
                    dummy.position.set(x + dx + 0.5, y, z + dz + 0.5);
                    dummy.updateMatrix();
                    roofMesh.setMatrixAt(roofMesh.count++, dummy.matrix);
                }
            }
        }
    }
}

function buildOccupancySet(voxelSet) {
    const set = new Set();
    voxelSet.forEach(v => {
        set.add(key(Math.round(v.position.x), Math.round(v.position.y), Math.round(v.position.z)));
    });
    return set;
}

function key(x, y, z) { return `${x}|${y}|${z}`; }

function isOnExterior(gx, gz, sizeX, sizeZ, occupancy, min) {
    const wx = Math.floor(min.x + gx);
    const wz = Math.floor(min.z + gz);
    // exterior if at perimeter of footprint
    const neighbors = [
        [wx + 1, wz], [wx - 1, wz], [wx, wz + 1], [wx, wz - 1]
    ];
    const here = occupancy.has(key(wx, Math.floor(min.y), wz));
    if (!here) return false;
    // If any neighbor is empty, treat as exterior
    for (const [nx, nz] of neighbors) {
        if (!occupancy.has(key(nx, Math.floor(min.y), nz))) return true;
    }
    // Single-tile footprints are also exterior
    if (sizeX <= 2 || sizeZ <= 2) return true;
    return false;
}

function pseudoNoise(n) {
    // Simple deterministic hash to [0,1]
    const x = Math.sin(n) * 43758.5453;
    return x - Math.floor(x);
}

function getBuildParams() {
    const subdivisions = parseInt(document.getElementById('voxelResolution').value, 10);
    const exactShape = parseFloat(document.getElementById('exactShape').value);
    const buildingType = document.getElementById('buildingType').value;
    const floorsPerSegment = parseInt(document.getElementById('floorsPerSegment').value, 10);
    const windowHeightSub = parseInt(document.getElementById('windowHeight').value, 10);
    const windowWidthSub = parseInt(document.getElementById('windowWidth').value, 10);
    const windowDensity = parseInt(document.getElementById('windowDensity').value, 10);
    return {
        subdivisions,
        exactShape,
        buildingType,
        floorsPerSegment,
        windowHeightSub,
        windowWidthSub,
        windowDensity
    };
}

function computeFocusedStructureBounds() {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    focusedStructureVoxels.forEach(v => {
        const p = v.position;
        minX = Math.min(minX, Math.round(p.x));
        minY = Math.min(minY, Math.round(p.y));
        minZ = Math.min(minZ, Math.round(p.z));
        maxX = Math.max(maxX, Math.round(p.x));
        maxY = Math.max(maxY, Math.round(p.y));
        maxZ = Math.max(maxZ, Math.round(p.z));
    });
    return { min: new THREE.Vector3(minX, minY, minZ), max: new THREE.Vector3(maxX, maxY, maxZ) };
}

function computeExteriorCells(bounds) {
    const { min, max } = bounds;
    const occupancy = buildOccupancySet(focusedStructureVoxels);
    const cells = [];
    const baseY = Math.floor(min.y);
    for (let x = Math.floor(min.x); x <= Math.floor(max.x); x++) {
        for (let z = Math.floor(min.z); z <= Math.floor(max.z); z++) {
            const here = occupancy.has(key(x, baseY, z));
            if (!here) continue;
            const neighbors = [ [x+1,z], [x-1,z], [x,z+1], [x,z-1] ];
            let exterior = false;
            for (const [nx, nz] of neighbors) {
                if (!occupancy.has(key(nx, baseY, nz))) { exterior = true; break; }
            }
            if (exterior) cells.push({ x, z });
        }
    }
    return cells;
}

function generateBuildifyModel() {
    const description = document.getElementById('modelDescription').value;
    const detailLevel = document.getElementById('detailLevel').value;
    const resolution = document.getElementById('voxelResolution').value;
    const colorPalette = document.getElementById('colorPalette').value;
    const style = document.getElementById('buildStyle').value;
    const preserveStructure = document.getElementById('preserveStructure').checked;
    const smoothEdges = document.getElementById('smoothEdges').checked;
    const addDetails = document.getElementById('addDetails').checked;
    
    if (!description.trim()) {
        alert('Please enter a model description');
        return;
    }
    
    // Show progress
    const progress = document.getElementById('buildifyProgress');
    progress.style.display = 'block';
    
    // Simulate generation process
    simulateGeneration();
    
    console.log('Generating model with settings:', {
        description,
        detailLevel,
        resolution,
        colorPalette,
        style,
        preserveStructure,
        smoothEdges,
        addDetails
    });
}

function previewBuildifyModel() {
    console.log('Previewing model...');
    // TODO: Implement preview functionality
}

function resetBuildifyModel() {
    console.log('Resetting model...');
    // TODO: Implement reset functionality
}

function simulateGeneration() {
    const progressFill = document.querySelector('.progress-fill');
    const progressText = document.querySelector('.progress-text');
    let progress = 0;
    
    const interval = setInterval(() => {
        progress += Math.random() * 15;
        if (progress >= 100) {
            progress = 100;
            clearInterval(interval);
            progressText.textContent = 'Complete!';
            setTimeout(() => {
                document.getElementById('buildifyProgress').style.display = 'none';
                progressFill.style.width = '0%';
                progressText.textContent = 'Generating...';
            }, 2000);
        }
        progressFill.style.width = progress + '%';
    }, 200);
}

function updateGizmos() {
    if (shiftPressed && selectedVoxels.length > 0) {
        createGizmos();
    } else {
        hideGizmos();
    }
}

function startGizmoDrag(gizmo, event) {
    isDraggingGizmo = true;
    activeGizmo = gizmo;
    dragAxis = gizmo.userData.axis;
    dragDirection = gizmo.userData.negative ? -1 : 1;
    dragStartPos = { x: event.clientX, y: event.clientY };
    
    // Highlight the active gizmo
    const color = dragDirection > 0 ? 
        (dragAxis === 'x' ? 0xff6666 : dragAxis === 'y' ? 0x66ff66 : 0x6666ff) :
        (dragAxis === 'x' ? 0xcc4444 : dragAxis === 'y' ? 0x44cc44 : 0x4444cc);
    
    gizmo.setColor(color);
    
    createDragPreview();
}

function updateDragPreview(event) {
    clearDragPreview();
    
    const dragDistance = Math.abs(event.clientX - dragStartPos.x) + Math.abs(event.clientY - dragStartPos.y);
    const extendAmount = Math.max(1, Math.floor(dragDistance / 50));
    
    selectedVoxels.forEach(voxel => {
        for (let i = 1; i <= extendAmount; i++) {
            const geometry = new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize);
            const edges = new THREE.EdgesGeometry(geometry);
            const line = new THREE.LineSegments(
                edges,
                new THREE.LineDashedMaterial({
                    color: 0x00ffff,
                    dashSize: 0.3,
                    gapSize: 0.2,
                    linewidth: 2
                })
            );
            
            const position = voxel.position.clone();
            if (dragAxis === 'y') {
                position.y = Math.round(position.y + dragDirection * i * voxelSize);
            } else if (dragAxis === 'x') {
                position.x = Math.round(position.x + dragDirection * i * voxelSize);
            } else if (dragAxis === 'z') {
                position.z = Math.round(position.z + dragDirection * i * voxelSize);
            }
            
            line.position.copy(position);
            line.computeLineDistances();
            previewGroup.add(line);
        }
    });
}

function clearDragPreview() {
    while(previewGroup.children.length > 0) {
        previewGroup.remove(previewGroup.children[0]);
    }
}

function createDragPreview() {
    clearDragPreview();
}

function finishGizmoDrag() {
    if (!isDraggingGizmo) return;
    
    const container = document.getElementById('scene-container');
    const rect = container.getBoundingClientRect();
    
    const dragDistance = Math.abs(event.clientX - dragStartPos.x) + Math.abs(event.clientY - dragStartPos.y);
    const extendAmount = Math.max(1, Math.floor(dragDistance / 50));
    
    const newVoxels = [];
    
    selectedVoxels.forEach(voxel => {
        for (let i = 1; i <= extendAmount; i++) {
            const geometry = new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize);
            const baseColor = voxel.userData.baseColor || new THREE.Color().setHSL(Math.random(), 0.5, 0.6).getHex();
            const material = new THREE.MeshPhongMaterial({ 
                color: baseColor,
                emissive: 0x000000,
                emissiveIntensity: 0
            });
            const cube = new THREE.Mesh(geometry, material);
            
            const position = voxel.position.clone();
            if (dragAxis === 'y') {
                position.y = Math.round(position.y + dragDirection * i * voxelSize);
            } else if (dragAxis === 'x') {
                position.x = Math.round(position.x + dragDirection * i * voxelSize);
            } else if (dragAxis === 'z') {
                position.z = Math.round(position.z + dragDirection * i * voxelSize);
            }
            
            cube.position.copy(position);
            cube.userData = { 
                type: 'voxel',
                selected: false,
                baseColor: baseColor
            };
            
            // Add edge highlights
            const edges = new THREE.EdgesGeometry(geometry);
            const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 });
            const edgeLines = new THREE.LineSegments(edges, edgeMaterial);
            edgeLines.position.copy(cube.position);
            cube.userData.edges = edgeLines;
            scene.add(edgeLines);
            
            // Apply height-based coloring
            updateVoxelColor(cube);
            
            cube.castShadow = true;
            cube.receiveShadow = true;
            
            scene.add(cube);
            voxels.push(cube);
            newVoxels.push(cube);
            
            // Add to focused structure if in focus mode
            addVoxelToFocusedStructure(cube);
        }
    });
    
    clearDragPreview();
    clearSelection();
    newVoxels.forEach(voxel => toggleSelection(voxel));
    
    // Only show gizmos if shift is still pressed
    if (shiftPressed && selectedVoxels.length > 0) {
        createGizmos();
    } else {
        hideGizmos();
    }
    
    // Reset gizmo color
    if (activeGizmo) {
        const originalColor = dragDirection > 0 ? 
            (dragAxis === 'x' ? 0xff0000 : dragAxis === 'y' ? 0x00ff00 : 0x0000ff) :
            (dragAxis === 'x' ? 0x880000 : dragAxis === 'y' ? 0x008800 : 0x000088);
        activeGizmo.setColor(originalColor);
    }
    
    isDraggingGizmo = false;
    activeGizmo = null;
    dragAxis = null;
    dragStartPos = null;
}

function saveSelectedStructure() {
    if (selectedVoxels.length === 0) {
        alert('No voxels selected!');
        return;
    }
    
    const structureData = selectedVoxels.map(voxel => ({
        position: voxel.position.toArray(),
        color: voxel.material.color.getHex(),
        size: voxelSize
    }));
    
    const structure = {
        id: Date.now(),
        name: `Structure ${savedStructures.length + 1}`,
        data: structureData,
        thumbnail: null
    };
    
    savedStructures.push(structure);
    updateStructuresMenu();
    clearSelection();
    
    ipcRenderer.invoke('save-structure', structure);
}

function updateStructuresMenu() {
    const list = document.getElementById('structures-list');
    list.innerHTML = '';
    
    savedStructures.forEach(structure => {
        const item = document.createElement('div');
        item.className = 'structure-item';
        item.innerHTML = `
            <div class="structure-preview"></div>
            <div class="structure-name">${structure.name}</div>
        `;
        
        item.addEventListener('click', () => loadStructure(structure));
        list.appendChild(item);
    });
}

function loadStructure(structure) {
    clearSelection();
    
    // Set this as the focused structure (for potential focus mode)
    focusedStructure = structure;
    
    // Find existing voxels that match the saved structure positions
    structure.data.forEach(voxelData => {
        const targetPos = new THREE.Vector3().fromArray(voxelData.position);
        targetPos.x = Math.round(targetPos.x);
        targetPos.y = Math.round(targetPos.y);
        targetPos.z = Math.round(targetPos.z);
        
        // Search through all existing voxels (ground grid and created voxels)
        const allObjects = [...groundGrid.flat(), ...voxels];
        const matchingVoxel = allObjects.find(voxel => {
            const voxelPos = voxel.position;
            return Math.abs(voxelPos.x - targetPos.x) < 0.1 && 
                   Math.abs(voxelPos.y - targetPos.y) < 0.1 && 
                   Math.abs(voxelPos.z - targetPos.z) < 0.1;
        });
        
        if (matchingVoxel) {
            toggleSelection(matchingVoxel);
        }
    });
    
    // Update gizmos if shift is pressed
    if (shiftPressed && selectedVoxels.length > 0) {
        createGizmos();
    }
}

function onWindowResize() {
    const container = document.getElementById('scene-container');
    const aspect = container.clientWidth / container.clientHeight;
    const frustumSize = 30;
    
    camera.left = frustumSize * aspect / -2;
    camera.right = frustumSize * aspect / 2;
    camera.top = frustumSize / 2;
    camera.bottom = frustumSize / -2;
    camera.updateProjectionMatrix();
    
    renderer.setSize(container.clientWidth, container.clientHeight);
}

function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

function createLinearDepthMaterial(nearZ, farZ, invert = false, gamma = 1.0, steps = 0) {
    return new THREE.ShaderMaterial({
        uniforms: {
            nearZ: { value: nearZ },
            farZ: { value: Math.max(nearZ + 1e-6, farZ) },
            invert: { value: invert ? 1.0 : 0.0 },
            gamma: { value: Math.max(1e-6, gamma) },
            steps: { value: Math.max(0.0, steps) }
        },
        vertexShader: `
            varying float vViewZ;
            void main() {
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                vViewZ = -mvPosition.z; // view-space forward distance
                gl_Position = projectionMatrix * mvPosition;
            }
        `,
        fragmentShader: `
            precision highp float;
            varying float vViewZ;
            uniform float nearZ;
            uniform float farZ;
            uniform float invert;
            uniform float gamma;
            uniform float steps;
            void main() {
                float d = clamp((vViewZ - nearZ) / (farZ - nearZ), 0.0, 1.0);
                // optional inversion so near is white
                d = mix(d, 1.0 - d, step(0.5, invert));
                // optional quantization to steps (clamped to [0,1])
                if (steps > 0.5) {
                    float denom = max(1.0, steps - 1.0);
                    d = floor(d * denom + 0.00001) / denom;
                }
                // gamma shaping (1.0 = linear)
                d = pow(d, gamma);
                gl_FragColor = vec4(vec3(clamp(d, 0.0, 1.0)), 1.0);
            }
        `,
        depthTest: true,
        depthWrite: true
    });
}

function computeDepthRangeForSet(voxelSet, cameraForDepth) {
    cameraForDepth.updateMatrixWorld(true);
    const viewMatrix = cameraForDepth.matrixWorldInverse.clone();

    // Sample 8 corners of each voxel instead of its center for robust near/far
    const half = voxelSize * 0.5;
    const offsets = [
        new THREE.Vector3(-half, -half, -half), new THREE.Vector3(half, -half, -half),
        new THREE.Vector3(-half, half, -half),  new THREE.Vector3(half, half, -half),
        new THREE.Vector3(-half, -half, half),  new THREE.Vector3(half, -half, half),
        new THREE.Vector3(-half, half, half),   new THREE.Vector3(half, half, half)
    ];

    let minZ = Infinity;
    let maxZ = -Infinity;
    voxelSet.forEach(v => {
        const base = v.position;
        for (let i = 0; i < offsets.length; i++) {
            const corner = base.clone().add(offsets[i]);
            const vp = corner.applyMatrix4(viewMatrix); // camera/view space
            const viewZ = -vp.z; // forward distance
            minZ = Math.min(minZ, viewZ);
            maxZ = Math.max(maxZ, viewZ);
        }
    });

    // Add a small margin to avoid clipping to 0/1
    const margin = Math.max(0.01, (maxZ - minZ) * 0.02);
    return { nearZ: Math.max(0.001, minZ - margin), farZ: maxZ + margin };
}

function snapSceneCameraToDefaultIso() {
    // Fit the scene roughly to current grid extents vertically centered
    const maxGridSize = Math.max(gridSizeX, gridSizeZ);
    const bounds = {
        min: new THREE.Vector3(-Math.floor(gridSizeX/2), 0, -Math.floor(gridSizeZ/2)),
        max: new THREE.Vector3(Math.ceil(gridSizeX/2), Math.max(1, heightLimit), Math.ceil(gridSizeZ/2))
    };

    const container = document.getElementById('scene-container');
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Compute target position for orthographic camera to emulate iso
    const center = new THREE.Vector3().addVectors(bounds.min, bounds.max).multiplyScalar(0.5);
    const elev = THREE.MathUtils.degToRad(DEFAULT_ISO_ELEVATION_DEG);
    const az = THREE.MathUtils.degToRad(DEFAULT_ISO_AZIMUTH_DEG);
    const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
    const radius = Math.max(1, size.length() * 0.5);
    const distance = radius * 2.5;
    const x = center.x + distance * Math.cos(elev) * Math.cos(az);
    const y = center.y + distance * Math.sin(elev);
    const z = center.z + distance * Math.cos(elev) * Math.sin(az);
    camera.position.set(x, y, z);
    camera.lookAt(center);

    // Adjust orthographic frustum to match aspect
    const aspect = (camera.right - camera.left) / (camera.top - camera.bottom) || (width / height);
    const frustumSize = 30 / currentZoom;
    camera.left = -frustumSize * aspect / 2;
    camera.right = frustumSize * aspect / 2;
    camera.top = frustumSize / 2;
    camera.bottom = -frustumSize / 2;
    camera.updateProjectionMatrix();
}