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
        currentZoom = Math.max(0.5, Math.min(3, currentZoom));
        
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
    const detailSlider = document.getElementById('detailLevel');
    const detailValue = document.getElementById('detailValue');
    const generateBtn = document.getElementById('generateModel');
    const previewBtn = document.getElementById('previewModel');
    const resetBtn = document.getElementById('resetModel');
    
    // Close button
    closeBuildify.addEventListener('click', () => {
        const buildifyMenu = document.getElementById('buildify-menu');
        buildifyMenu.style.display = 'none';
    });
    
    // Detail level slider
    detailSlider.addEventListener('input', (event) => {
        detailValue.textContent = event.target.value;
    });
    
    // Generate model button
    generateBtn.addEventListener('click', () => {
        generateBuildifyModel();
    });
    
    // Preview button
    previewBtn.addEventListener('click', () => {
        previewBuildifyModel();
    });
    
    // Reset button
    resetBtn.addEventListener('click', () => {
        resetBuildifyModel();
    });
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