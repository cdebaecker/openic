# chipsynth: live synthesis of the music for the Godot game (native/README.md).
#   cmake -S native -B native/build -DDEPS=<folder with godot-cpp and ymfm> && cmake --build native/build --config Release
# tools/native/build.mjs fetches the dependencies and runs this.
cmake_minimum_required(VERSION 3.17)
project(chipsynth CXX)

set(DEPS "${CMAKE_CURRENT_SOURCE_DIR}/deps" CACHE PATH "godot-cpp and ymfm checkouts")
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    add_compile_definitions(_USE_MATH_DEFINES)
endif()

add_library(ymfm STATIC "${DEPS}/ymfm/src/ymfm_opm.cpp")
target_include_directories(ymfm PUBLIC "${DEPS}/ymfm/src")

add_library(chipcore STATIC src/chipsynth.cpp)
target_link_libraries(chipcore PUBLIC ymfm)
target_include_directories(chipcore PUBLIC src)

add_executable(icl2wav src/icl2wav.cpp)
target_link_libraries(icl2wav PRIVATE chipcore)

set(GODOTCPP_TARGET "template_release" CACHE STRING "")
add_subdirectory("${DEPS}/godot-cpp" godot-cpp EXCLUDE_FROM_ALL)
add_library(chipsynth SHARED src/godot_chipsynth.cpp)
target_link_libraries(chipsynth PRIVATE chipcore godot-cpp)
get_target_property(GODOTCPP_SUFFIX godot-cpp GODOTCPP_SUFFIX)
set(OUT "${CMAKE_CURRENT_SOURCE_DIR}/../godot/bin")
set_target_properties(chipsynth PROPERTIES
    POSITION_INDEPENDENT_CODE ON
    OUTPUT_NAME "chipsynth${GODOTCPP_SUFFIX}"
    PREFIX ""
    LIBRARY_OUTPUT_DIRECTORY "$<1:${OUT}>"
    RUNTIME_OUTPUT_DIRECTORY "$<1:${OUT}>")
