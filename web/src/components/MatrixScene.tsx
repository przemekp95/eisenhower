import { Canvas } from '@react-three/fiber';
import { OrbitControls, Sphere } from '@react-three/drei';

export default function MatrixScene() {
  return (
    <div className="absolute inset-0 opacity-70">
      <Canvas camera={{ position: [0, 0, 4] }}>
        <ambientLight intensity={0.7} />
        <pointLight position={[3, 3, 3]} intensity={1.2} />
        <Sphere args={[1, 48, 48]}>
          <meshStandardMaterial color="#0f766e" roughness={0.2} metalness={0.35} />
        </Sphere>
        <OrbitControls enablePan={false} enableZoom={false} autoRotate />
      </Canvas>
    </div>
  );
}
