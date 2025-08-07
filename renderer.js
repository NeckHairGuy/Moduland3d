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
let gridSize = 20;
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
    const gridHelper = new THREE.GridHelper(gridSize, gridSize, 0x888888, 0xcccccc);
    scene.add(gridHelper);
    
    const planeGeometry = new THREE.PlaneGeometry(gridSize, gridSize);
    const planeMaterial = new THREE.MeshBasicMaterial({ 
        color: 0xffffff, 
        opacity: 0.1, 
        transparent: true,
        side: THREE.DoubleSide
    });
    const plane = new THREE.Mesh(planeGeometry, planeMaterial);
    plane.rotation.x = -Math.PI / 2;
    plane.receiveShadow = true;
    scene.add(plane);
    
    for (let x = 0; x < gridSize; x++) {
        groundGrid[x] = [];
        for (let z = 0; z < gridSize; z++) {
            const geometry = new THREE.BoxGeometry(voxelSize * 0.9, voxelSize * 0.9, voxelSize * 0.9);
            const material = new THREE.MeshPhongMaterial({ 
                color: 0xe0e0e0,
                emissive: 0x000000,
                emissiveIntensity: 0
            });
            const cube = new THREE.Mesh(geometry, material);
            cube.position.set(
                Math.floor(x - gridSize / 2 + 0.5),
                0,
                Math.floor(z - gridSize / 2 + 0.5)
            );
            cube.userData = { gridX: x, gridZ: z, type: 'ground', selected: false };
            cube.castShadow = true;
            cube.receiveShadow = true;
            scene.add(cube);
            groundGrid[x][z] = cube;
        }
    }
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
    let previousMousePosition = { x: 0, y: 0 };
    
    renderer.domElement.addEventListener('mousedown', (event) => {
        if (event.button === 2) {
            isRotating = true;
            previousMousePosition = { x: event.clientX, y: event.clientY };
        }
    });
    
    renderer.domElement.addEventListener('mousemove', (event) => {
        if (isRotating) {
            const deltaX = event.clientX - previousMousePosition.x;
            const deltaY = event.clientY - previousMousePosition.y;
            
            const rotationSpeed = 0.005;
            const spherical = new THREE.Spherical();
            spherical.setFromVector3(camera.position);
            spherical.theta -= deltaX * rotationSpeed;
            spherical.phi += deltaY * rotationSpeed;
            spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, spherical.phi));
            
            camera.position.setFromSpherical(spherical);
            camera.lookAt(0, 0, 0);
            
            previousMousePosition = { x: event.clientX, y: event.clientY };
        }
    });
    
    renderer.domElement.addEventListener('mouseup', () => {
        isRotating = false;
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
            const geometry = new THREE.BoxGeometry(voxelSize * 0.9, voxelSize * 0.9, voxelSize * 0.9);
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
            const geometry = new THREE.BoxGeometry(voxelSize * 0.9, voxelSize * 0.9, voxelSize * 0.9);
            const material = new THREE.MeshPhongMaterial({ 
                color: voxel.material.color.clone(),
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
                selected: false
            };
            cube.castShadow = true;
            cube.receiveShadow = true;
            
            scene.add(cube);
            voxels.push(cube);
            newVoxels.push(cube);
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
    
    structure.data.forEach(voxelData => {
        const geometry = new THREE.BoxGeometry(voxelData.size * 0.9, voxelData.size * 0.9, voxelData.size * 0.9);
        const material = new THREE.MeshPhongMaterial({ 
            color: voxelData.color,
            emissive: 0x000000,
            emissiveIntensity: 0
        });
        const cube = new THREE.Mesh(geometry, material);
        
        cube.position.fromArray(voxelData.position);
        cube.position.x = Math.round(cube.position.x);
        cube.position.y = Math.round(cube.position.y + 5);
        cube.position.z = Math.round(cube.position.z);
        
        cube.userData = { 
            type: 'voxel',
            selected: false
        };
        cube.castShadow = true;
        cube.receiveShadow = true;
        
        scene.add(cube);
        voxels.push(cube);
        toggleSelection(cube);
    });
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